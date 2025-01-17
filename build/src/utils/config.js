/*--------------------------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See https://go.microsoft.com/fwlink/?linkid=2090316 for license information.
 *-------------------------------------------------------------------------------------------------------------*/

const os = require('os');
const path = require('path');
const asyncUtils = require('./async');
const jsonc = require('jsonc').jsonc;
const config = require('../../config.json');

config.definitionDependencies = config.definitionDependencies || {};
config.definitionBuildSettings = config.definitionBuildSettings || {};
config.definitionVersions = config.definitionVersions || {};
config.definitionVariants = config.definitionVariants || {};

const stagingFolders = {};
const definitionTagLookup = {};
const allDefinitionPaths = {};
let variantsList = [];
let skipParentVariants = [];

// Must be called first
async function loadConfig(repoPath) {
    repoPath = repoPath || path.join(__dirname, '..', '..', '..');
    const imageBuildConfigFile = getConfig('imageBuildConfigFile', 'manifest.json');

    // Get list of image folders
    const containersPath = path.join(repoPath, 'src');
    const definitions = await asyncUtils.readdir(containersPath, { withFileTypes: true });
    await asyncUtils.forEach(definitions, async (definitionFolder) => {
        // If directory entry is a file (like README.md, skip
        if (!definitionFolder.isDirectory()) {
            return;
        }

        const definitionId = definitionFolder.name;
        const definitionPath = path.resolve(path.join(containersPath, definitionId));

        // If a .deprecated file is found, remove the directory from staging and return
        if(await asyncUtils.exists(path.join(definitionPath, '.deprecated'))) {
            await asyncUtils.rimraf(definitionPath);
            return;
        }

        // Add to complete list of definitions
        allDefinitionPaths[definitionId] = {
            path: definitionPath,
            relativeToRootPath: path.relative(repoPath, definitionPath)
        }
        // If manifest.json exists, load it
        const manifestPath = path.join(definitionPath, imageBuildConfigFile);
        if (await asyncUtils.exists(manifestPath)) {
            await loadDefinitionManifest(manifestPath, definitionId);
        }
    });

    // Populate image variants and tag lookup
    for (let definitionId in config.definitionBuildSettings) {
        const buildSettings = config.definitionBuildSettings[definitionId];
        const definitionVariants = config.definitionVariants[definitionId];
        const dependencies = config.definitionDependencies[definitionId];
        buildSettings.architecture = buildSettings.architecture || ['linux/amd64'];

        // Populate images list for variants for dependency registration
        dependencies.imageVariants = definitionVariants ?
            definitionVariants.map((variant) => dependencies.image.replace('${VARIANT}', variant)) :
            [dependencies.image];

        // Populate image and variant lookup
        if (buildSettings.tags) {
            // Variants can be used as a VARAINT arg in tags, so support that too. However, these can
            // get overwritten in certain tag configs resulting in bad lookups, so **process them first**.
            const variants = definitionVariants ? ['${VARIANT}', '$VARIANT'].concat(definitionVariants) : [undefined];
            
            variants.forEach((variant) => {
                const blankTagList = getTagsForVersion(definitionId, '', 'ANY', 'ANY', variant);
                blankTagList.forEach((blankTag) => {
                    definitionTagLookup[blankTag] = {
                        id: definitionId,
                        variant: variant
                    };
                });
                const devTagList = getTagsForVersion(definitionId, 'dev', 'ANY', 'ANY', variant);
                devTagList.forEach((devTag) => {
                    definitionTagLookup[devTag] = {
                        id: definitionId,
                        variant: variant
                    }
                });
            })
        }
    }
    config.needsDedicatedPage = config.needsDedicatedPage || [];
}

// Get a value from the config file or a similarly named env var
function getConfig(property, defaultVal) {
    defaultVal = defaultVal || null;
    // Generate env var name from property - camelCase to CAMEL_CASE
    const envVar = property.split('').reduce((prev, next) => {
        if (next >= 'A' && next <= 'Z') {
            return prev + '_' + next;
        } else {
            return prev + next.toLocaleUpperCase();
        }
    }, '');

    return process.env[envVar] || config[property] || defaultVal;
}

// Loads manifest.json and adds it to config
async function loadDefinitionManifest(manifestPath, definitionId) {
    const buildJson = await jsonc.read(manifestPath);
    if (buildJson.variants) {
        config.definitionVariants[definitionId] = buildJson.variants;
    }
    if (buildJson.build) {
        config.definitionBuildSettings[definitionId] = buildJson.build;
    }
    if (buildJson.dependencies) {
        config.definitionDependencies[definitionId] = buildJson.dependencies;
    }
    if (buildJson.version) {
        config.definitionVersions[definitionId] = buildJson.version;
    }
}

// Returns location of the definition based on name
function getDefinitionPath(definitionId, relative) {
    return relative ? allDefinitionPaths[definitionId].relativeToRootPath : allDefinitionPaths[definitionId].path
}

function getAllDefinitionPaths() {
    return allDefinitionPaths;
}

// Convert a release string (v1.0.0) or branch (main) into a version. If a definitionId and 
// release string is passed in, use the version specified in defintion-build.json if one exists.
function getVersionFromRelease(release, definitionId) {
    definitionId = definitionId || 'NOT SPECIFIED';

    // Is a release string
    if (release.charAt(0) === 'v' && !isNaN(parseInt(release.charAt(1)))) {
        return config.definitionVersions[definitionId];
    }

    // Is a branch
    return 'dev';
}

// Look up distro and fallback to debian if not specified
function getLinuxDistroForDefinition(definitionId) {
    return config.definitionBuildSettings[definitionId].rootDistro || 'debian';
}

// Generate 'latest' flavor of a given image's tag
function getLatestTag(definitionId, registry, registryPath) {
    if (typeof config.definitionBuildSettings[definitionId] === 'undefined') {
        return null;
    }

    // Given there could be multiple registries in the tag list, get all the different latest variations
    return config.definitionBuildSettings[definitionId].tags.reduce((list, tag) => {
        const latest = `${registry}/${registryPath}/${tag.replace(/:.+/, ':latest')}`
        if (list.indexOf(latest) < 0) {
            list.push(latest);
        }
        return list;
    }, []);

}

function getVariants(definitionId) {
    return config.definitionVariants[definitionId] || null;
}

// Create all the needed variants of the specified version identifier for a given image
function getTagsForVersion(definitionId, version, registry, registryPath, variant) {
    if (typeof config.definitionBuildSettings[definitionId] === 'undefined') {
        return null;
    }

    // If the image states that only versioned tags are returned and the version is 'dev', 
    // add the image name to ensure that we do not incorrectly hijack a tag from another image.
    if (version === 'dev') {
        version = config.definitionBuildSettings[definitionId].versionedTagsOnly ? `dev-${definitionId.replace(/-/mg,'')}` : 'dev';
    }


    // Use the first variant if none passed in, unless there isn't one
    if (!variant) {
        const variants = getVariants(definitionId);
        variant = variants ? variants[0] : 'NOVARIANT';
    }
    let tags = config.definitionBuildSettings[definitionId].tags;

    // See if there are any variant specific tags that should be added to the output
    const variantTags = config.definitionBuildSettings[definitionId].variantTags;
    // ${VARIANT} or $VARIANT may be passed in as a way to do lookups. Add all in this case.
    if (['${VARIANT}', '$VARIANT'].indexOf(variant) > -1) {
        if (variantTags) {
            for (let variantEntry in variantTags) {
                tags = tags.concat(variantTags[variantEntry] || []);
            }
        }
    } else {
        if (variantTags) {
            tags = tags.concat(variantTags[variant] || []);
        }
    }

    return tags.reduce((list, tag) => {
        // One of the tags that needs to be supported is one where there is no version, but there
        // are other attributes. For example, python:3 in addition to python:0.35.0-3. So, a version
        // of '' is allowed. However, there are also instances that are just the version, so in 
        // these cases latest would be used instead. However, latest is passed in separately.
        let baseTag = tag.replace('${VERSION}', version)
            .replace(':-', ':')
            .replace(/\$\{?VARIANT\}?/, variant || 'NOVARIANT')
            .replace('-NOVARIANT', '');
        if (baseTag.charAt(baseTag.length - 1) !== ':') {
            list.push(`${registry}/${registryPath}/${baseTag}`);
        }
        return list;
    }, []);
}

/* 
Generate complete list of tags for a given image.

versionPartHandling has a few different modes:
    - true/'all-latest' - latest, X.X.X, X.X, X
    - false/'all' - X.X.X, X.X, X
    - 'full-only' - X.X.X
    - 'major-minor' - X.X
    - 'major' - X
*/
function getTagList(definitionId, release, versionPartHandling, registry, registryPath, variant) {
    const version = getVersionFromRelease(release, definitionId);

    // If version is 'dev', there's no need to generate semver tags for the version
    // (e.g. for 1.0.2, we should also tag 1.0 and 1). So just return the tags for 'dev'.
    if (version === 'dev') {
        return getTagsForVersion(definitionId, version, registry, registryPath, variant);
    }

    // If this is a release version, split it out into the three parts of the semver
    const versionParts = version.split('.');
    if (versionParts.length !== 3) {
        throw (`Invalid version format in ${version}.`);
    }

    let versionList, updateUnversionedTags, updateLatest;
    switch(versionPartHandling) {
        case true:
        case 'all-latest':
            updateLatest = true; 
            updateUnversionedTags = true;
            versionList = [version,`${versionParts[0]}.${versionParts[1]}`, `${versionParts[0]}` ];
            break;
        case false:
        case 'all':
            updateLatest = false;
            updateUnversionedTags = true;
            versionList = [version,`${versionParts[0]}.${versionParts[1]}`, `${versionParts[0]}` ];
            break;
        case 'full-only':
            updateLatest = false;
            updateUnversionedTags = false;
            versionList = [version];
            break;
        case 'major-minor':
            updateLatest = false;
            updateUnversionedTags = false;
            versionList = [`${versionParts[0]}.${versionParts[1]}`];
            break;
        case 'major':
            updateLatest = false;
            updateUnversionedTags = false;
            versionList = [ `${versionParts[0]}`];
            break;
    }

    // Normally, we also want to return a tag without a version number, but for
    // some definitions that exist in the same repository as others, we may
    // only want to return a list of tags with part of the version number in it
    if(updateUnversionedTags && !config.definitionBuildSettings[definitionId].versionedTagsOnly) {
        // This is the equivalent of latest for qualified tags- e.g. python:3 instead of python:0.35.0-3
        versionList.push(''); 
    }

    const allVariants = getVariants(definitionId);
    const firstVariant = allVariants ? allVariants[0] : variant;
    let tagList = [];

    versionList.forEach((tagVersion) => {
        tagList = tagList.concat(getTagsForVersion(definitionId, tagVersion, registry, registryPath, variant));
    });

    // If this variant should also be used for the the latest tag, add it. The "latest" value could be
    // true, false, or a specific variant. "true" assumes the first variant is the latest.
    const definitionLatestProperty = config.definitionBuildSettings[definitionId].latest;
    return tagList.concat((updateLatest 
        && definitionLatestProperty
        && (!allVariants
            || variant === definitionLatestProperty 
            || (definitionLatestProperty === true && variant === firstVariant)))
        ? getLatestTag(definitionId, registry, registryPath)
        : []);
}

const getDefinitionObject = (id, variant) => {
    return {
        id,
        variant
    }
}

// Walk the image build config and paginate and sort list so parents build before (and with) children
function getSortedDefinitionBuildList(page, pageTotal, definitionsToSkip) {
    page = page || 1;
    pageTotal = pageTotal || 1;
    definitionsToSkip = definitionsToSkip || [];

    // Bucket definitions by parent
    const parentBuckets = {};
    const dupeBuckets = [];
    const noParentList = [];
    for (let definitionId in config.definitionBuildSettings) {
        // If paged build, ensure this image should be included
        if (typeof config.definitionBuildSettings[definitionId] === 'object') {
            if (definitionsToSkip.indexOf(definitionId) < 0) {
                let parentId = config.definitionBuildSettings[definitionId].parent;
                if (parentId) {
                    // if multi-parent, merge the buckets
                    if (typeof parentId !== 'string') {
                        parentId = createMultiParentBucket(parentId, parentBuckets, dupeBuckets);
                    }
                    bucketDefinition(definitionId, parentId, parentBuckets);
                } else {
                    noParentList.push(definitionId);
                }
            } else {
                console.log(`(*) Skipping ${definitionId}.`)
            }
        }
    }
    // Remove duplicate buckets that are no longer needed
    dupeBuckets.forEach((currentBucketId) => {
        parentBuckets[currentBucketId] = undefined;
    });
    // Remove parents from no parent list - they are in their buckets already
    for (let parentId in parentBuckets) {
        if (parentId) {
            noParentList.splice(noParentList.indexOf(parentId), 1);
        }
    }


    // Configure and club dependent variants together.
    for (let id in parentBuckets) {
        const definitionBucket = parentBuckets[id];
        if (definitionBucket) {
            definitionBucket.reverse().forEach(definitionId => {
                let variants = config.definitionVariants[definitionId];
                let parentId = config.definitionBuildSettings[definitionId].parent;

                // eg. id: base-debian ; variant: stretch
                // base-debian is part of parentId, but the variant does not have an interdependent definition.
                if (!parentId && variants) {
                    variants.forEach(variant => {
                        const skipVariant = skipParentVariants.filter(item => item.id === definitionId && item.variant === variant);
                        if (skipVariant.length === 0) {
                            variantsList.push([getDefinitionObject(definitionId, variant)]);
                        }
                    });
                } else if (typeof parentId == 'string') {
                    // eg. id: ruby ; variant: 2.7-bullseye which needs to be build before id: jekyll ; variant: 2.7-bullseye 
                    let parentVariants = config.definitionVariants[parentId];
                    if (variants) {
                        variants.forEach(variant => {
                            const variantId = config.definitionBuildSettings[definitionId].idMismatch === "true" && variant.includes('-') ? variant.split('-')[1] : variant;
                            if (parentVariants.includes(variantId)) {
                                const parentItem = getDefinitionObject(parentId, variantId);
                                const childItem = getDefinitionObject(definitionId, variant);
                                addToVariantsList(parentItem, childItem);
                            } else {
                                variantsList.push([getDefinitionObject(definitionId, variant)]);
                            }
                        });
                    } else {
                        let tags = config.definitionBuildSettings[definitionId].tags;
                        if (tags) {
                            const item = [
                                getDefinitionObject(id, undefined),
                                getDefinitionObject(definitionId, undefined),
                            ]
                            variantsList.push(item);
                        }
                    }
                } else if (typeof parentId == 'object') {
                    // eg. cpp
                    for (const id in parentId) {
                        let parentObjId = parentId[id];
                        let parentVariants = config.definitionVariants[parentObjId];
                        let commonVariant = id;

                        if (commonVariant) {
                            const shouldAddSingleVariant = parentId[commonVariant];
                            if (parentVariants.includes(commonVariant)) {
                                const parentItem = getDefinitionObject(parentObjId, commonVariant);
                                const childItem = getDefinitionObject(definitionId, commonVariant);
                                addToVariantsList(parentItem, childItem);
                            } else if (shouldAddSingleVariant) {
                                variantsList.push([getDefinitionObject(definitionId, commonVariant)]);
                            }
                        }
                        else {
                            let tags = config.definitionBuildSettings[definitionId].tags;
                            if (tags) {
                                const item = [
                                    getDefinitionObject(id, undefined),
                                    getDefinitionObject(definitionId, undefined)
                                ]
                                variantsList.push(item);
                            }
                        }
                    }
                }
            });
        }
    }

    // As 'noParentList' does not have parents, add each variant to a separate object
    noParentList.forEach(definitionId => {
        let variants = config.definitionVariants[definitionId];
        if (variants) {
            variants.forEach(variant => {
                variantsList.push([getDefinitionObject(definitionId, variant)]);
            });
        } else {
            let tags = config.definitionBuildSettings[definitionId].tags;
            if (tags) {
                variantsList.push([getDefinitionObject(definitionId, undefined)]);
            }
        }
    });

    let allPages = variantsList;

    console.log(`(*) Builds pagination needs at least ${variantsList.length} pages to parallelize jobs efficiently.\n`);

    if (allPages.length > pageTotal) {
        // If too many pages, add extra pages to last one
        console.log(`(!) Not enough pages to for target page size. Adding excess definitions to last page.`);
        let i = pageTotal;
        while (i < allPages.length) {
            allPages[pageTotal - 1] = allPages[pageTotal - 1].concat(allPages[i]);
            allPages.splice(i, 1);
        }
    } else if (allPages.length < pageTotal) {
        // If too few, add some empty pages
        for (let i = allPages.length; i < pageTotal; i++) {
            allPages.push([]);
        }
    }

    console.log(`(*) Builds paginated as follows: ${JSON.stringify(allPages, null, 4)}\n(*) Processing page ${page} of ${pageTotal}.\n`);

    return allPages[page - 1];
}

function addToVariantsList(parentItem, childItem) {
    let isAdded = false;
    for (let x = 0; x < variantsList.length; x++) {
        for (let y = 0; y < variantsList[x].length; y++) {
            const variantItem = variantsList[x][y];
            if (variantItem.id === parentItem.id && variantItem.variant === parentItem.variant) {
                variantsList[x].push(childItem);
                isAdded = true;
                break;
            }
        }

        if (isAdded) {
            break;
        }
    }

    if (!isAdded) {
        const item = [
            parentItem,
            childItem
        ]

        variantsList.push(item);
    }

    skipParentVariants.push(parentItem);
}

function getDefinitionList() {
    let definitionList = [];
    for (let definitionId in config.definitionBuildSettings) {
        definitionList.push(definitionId);
    }

    return definitionList;
}

// Handle multi-parent definitions
function createMultiParentBucket(variantParentMap, parentBuckets, dupeBuckets) {
    // Get parent of first variant
    const parentId = variantParentMap[Object.keys(variantParentMap)[0]];
    const firstParentBucket =  parentBuckets[parentId] || [parentId];
    // Merge other parent buckets into the first parent
    for (let currentVariant in variantParentMap) {
        const currentParentId = variantParentMap[currentVariant];
        if (currentParentId !== parentId) {
            const currentParentBucket = parentBuckets[currentParentId];
            // Merge buckets if not already merged
            if (currentParentBucket && dupeBuckets.indexOf(currentParentId) < 0) {
                currentParentBucket.forEach((current) => firstParentBucket.push(current));
            } else if (firstParentBucket.indexOf(currentParentId)<0) {
                firstParentBucket.push(currentParentId);
            }
            dupeBuckets.push(currentParentId);
            parentBuckets[currentParentId]=firstParentBucket;
        }
    }
    parentBuckets[parentId] = firstParentBucket;
    return parentId;
}

// Add image to correct parent bucket when sorting
function bucketDefinition(definitionId, parentId, parentBuckets) {
    // Handle parents that have parents
    // TODO: Recursive parents rather than just parents-of-parents
    if (config.definitionBuildSettings[parentId].parent) {
        const oldParentId = parentId;
        parentId = config.definitionBuildSettings[parentId].parent;
        parentBuckets[parentId] = parentBuckets[parentId] || [parentId];
        if (parentBuckets[parentId].indexOf(oldParentId) < 0) {
            parentBuckets[parentId].push(oldParentId);
        }
    }

    // Add to parent bucket
    parentBuckets[parentId] = parentBuckets[parentId] || [parentId];
    if (parentBuckets[parentId].indexOf(definitionId) < 0) {
        parentBuckets[parentId].push(definitionId);
    }
}

// Get parent tag for a given child image
function getParentTagForVersion(definitionId, version, registry, registryPath, variant) {
    let parentId = config.definitionBuildSettings[definitionId].parent;
    if (parentId) {
        if(typeof parentId !== 'string') {
            // Use variant to figure out correct parent, or return first parent if child has no variant
            parentId = variant ? parentId[variant] : parentId[Object.keys(parentId)[0]];
        }
    
        // Determine right parent variant to use (assuming there are variants)
        const parentVariantList = getVariants(parentId);
        let parentVariant;
        if(parentVariantList) {
            // If a variant is specified in the parentVariant property in build, use it - otherwise default to the child image's variant
            parentVariant = config.definitionBuildSettings[definitionId].parentVariant || variant;
            if(typeof parentVariant !== 'string') {
                // Use variant to figure out correct variant it not the same across all parents, or return first variant if child has no variant
                parentVariant = variant ? parentVariant[variant] : parentVariant[Object.keys(parentId)[0]];
            }
            const parentVariantId = config.definitionBuildSettings[definitionId].idMismatch === "true" && variant.includes('-') ? variant.split('-')[1] : variant;
            if(!parentVariantList.includes(parentVariantId)) {
                throw `Unable to determine variant for parent. Variant ${parentVariantId} is not in ${parentId} list: ${parentVariantList}`;
            }
        }
        
        // Parent image version may be different than child's
        const parentVersion = getVersionFromRelease(version, parentId);
        return getTagsForVersion(parentId, parentVersion, registry, registryPath, parentVariant)[0];
    }
    return null;
}

// Takes an existing tag and updates it with a new registry version and optionally a variant
function getUpdatedTag(currentTag, currentRegistry, currentRegistryPath, updatedVersion, updatedRegistry, updatedRegistryPath, variant) {
    updatedRegistry = updatedRegistry || currentRegistry;
    updatedRegistryPath = updatedRegistryPath || currentRegistryPath;

    const definition = getDefinitionFromTag(currentTag, currentRegistry, currentRegistryPath);

    // If definition not found, fall back on swapping out more generic logic - e.g. for when a image already has a version tag in it
    if (!definition) {
        const repository = new RegExp(`${currentRegistry}/${currentRegistryPath}/(.+):`).exec(currentTag)[1];
        const updatedTag = currentTag.replace(new RegExp(`${currentRegistry}/${currentRegistryPath}/${repository}:(dev-|${updatedVersion}-)?`), `${updatedRegistry}/${updatedRegistryPath}/${repository}:${updatedVersion}-`);
        console.log(`    Using RegEx to update ${currentTag}\n    to ${updatedTag}`);
        return updatedTag;
    }

    // See if definition found and no variant passed in, see if definition lookup returned a variant match
    if (!variant) {
        variant = definition.variant;
    }

    const updatedTags = getTagsForVersion(definition.id, updatedVersion, updatedRegistry, updatedRegistryPath, variant);
    if (updatedTags && updatedTags.length > 0) {
        console.log(`    Updating ${currentTag}\n    to ${updatedTags[0]}`);
        return updatedTags[0];
    }
    // In the case where this is already a tag with a version number in it,
    // we won't get an updated tag returned, so we'll just reuse the current tag.
    return currentTag;
}

// Lookup definition from a tag
function getDefinitionFromTag(tag, registry, registryPath) {
    registry = registry || '.+';
    registryPath = registryPath || '.+';
    const captureGroups = new RegExp(`${registry}/${registryPath}/(.+):(.+)`).exec(tag);
    const repo = captureGroups[1];
    const tagPart = captureGroups[2];
    const definition = definitionTagLookup[`ANY/ANY/${repo}:${tagPart}`];
    if (definition) {
        return definition;
    }

    // If lookup fails, try removing a numeric first part - dev- is already handled
    return definitionTagLookup[`ANY/ANY/${repo}:${tagPart.replace(/^\d+-/,'')}`];
}

// Return just the major version of a release number
function majorFromRelease(release, definitionId) {
    const version = getVersionFromRelease(release, definitionId);

    if (version === 'dev') {
        return 'dev';
    }

    const versionParts = version.split('.');
    return versionParts[0];
}

// Return an object from a map based on the linux distro for the definition
function objectByDefinitionLinuxDistro(definitionId, objectsByDistro) {
    const distro = getLinuxDistroForDefinition(definitionId);
    const obj = objectsByDistro[distro];
    return obj;
}

function getDefinitionDependencies(definitionId) {
    return config.definitionDependencies[definitionId];
}

function getAllDependencies() {
    return config.definitionDependencies;
}

function getPoolKeyForPoolUrl(poolUrl) {
    const poolKey = config.poolKeys[poolUrl];
    return poolKey;
}

function getFallbackPoolUrl(package) {
    const poolUrl = config.poolUrlFallback[package];
    console.log (`(*) Fallback pool URL for ${package} is ${poolUrl}`);
    return poolUrl;
}


async function getStagingFolder(release) {
    if (!stagingFolders[release]) {
        const stagingFolder = path.join(os.tmpdir(), 'dev-containers', release);
        console.log(`(*) Copying files to ${stagingFolder}\n`);
        await asyncUtils.rimraf(stagingFolder); // Clean out folder if it exists
        await asyncUtils.mkdirp(stagingFolder); // Create the folder
        await asyncUtils.copyFiles(
            path.resolve(__dirname, '..', '..', '..'),
            getConfig('filesToStage'),
            stagingFolder);
        
        stagingFolders[release] = stagingFolder;
    }
    return stagingFolders[release];
}

function shouldFlattenDefinitionBaseImage(definitionId) {
    return (getConfig('flattenBaseImage', []).indexOf(definitionId) >= 0)
}

function getDefaultDependencies(dependencyType) {
    const packageManagerConfig = getConfig('commonDependencies');
    return packageManagerConfig ? packageManagerConfig[dependencyType] : null;
} 

function getBuildSettings(definitionId) {
    return config.definitionBuildSettings[definitionId];
}

module.exports = {
    loadConfig: loadConfig,
    getTagList: getTagList,
    getVariants: getVariants,
    getAllDefinitionPaths: getAllDefinitionPaths,
    getBuildSettings: getBuildSettings,
    getDefinitionFromTag: getDefinitionFromTag,
    getDefinitionPath: getDefinitionPath,
    getSortedDefinitionBuildList: getSortedDefinitionBuildList,
    getParentTagForVersion: getParentTagForVersion,
    getUpdatedTag: getUpdatedTag,
    majorFromRelease: majorFromRelease,
    objectByDefinitionLinuxDistro: objectByDefinitionLinuxDistro,
    getDefinitionDependencies: getDefinitionDependencies,
    getAllDependencies: getAllDependencies,
    getDefaultDependencies: getDefaultDependencies,
    getStagingFolder: getStagingFolder,
    getLinuxDistroForDefinition: getLinuxDistroForDefinition,
    getVersionFromRelease: getVersionFromRelease,
    getTagsForVersion: getTagsForVersion,
    getFallbackPoolUrl: getFallbackPoolUrl,
    getPoolKeyForPoolUrl: getPoolKeyForPoolUrl,
    getConfig: getConfig,
    shouldFlattenDefinitionBaseImage: shouldFlattenDefinitionBaseImage,
    getDefinitionList: getDefinitionList
};
