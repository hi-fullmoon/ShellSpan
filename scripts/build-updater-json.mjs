import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const UPDATER_ARCHIVE_PATTERNS = [
  '.app.tar.gz',
  '.AppImage.tar.gz',
  '.msi.zip',
  '.nsis.zip',
  '.exe.zip',
];

async function walkFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        return walkFiles(fullPath);
      }
      return fullPath;
    }),
  );

  return files.flat();
}

async function readArtifactMetadata(metadataPath) {
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (!metadata.platform) {
    throw new Error(`Missing platform in metadata: ${metadataPath}`);
  }

  return metadata;
}

function findUpdaterArchive(files, preferredSuffix, platform) {
  const candidates = files.filter((filePath) =>
    UPDATER_ARCHIVE_PATTERNS.some((suffix) => filePath.endsWith(suffix)),
  );
  const matches = preferredSuffix
    ? candidates.filter((filePath) => filePath.endsWith(preferredSuffix))
    : candidates;

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${preferredSuffix || 'updater'} archive for ${platform}, found ${matches.length}`,
    );
  }

  return matches[0];
}

export async function buildUpdaterManifest({
  artifactsRootDir,
  notes,
  repoSlug,
  tag,
}) {
  const allFiles = await walkFiles(artifactsRootDir);
  const metadataFiles = allFiles.filter((filePath) =>
    filePath.endsWith('release-metadata.json'),
  );

  if (metadataFiles.length === 0) {
    throw new Error(`No release metadata found in ${artifactsRootDir}`);
  }

  const platforms = {};

  for (const metadataPath of metadataFiles) {
    const metadata = await readArtifactMetadata(metadataPath);
    const artifactDir = path.dirname(metadataPath);
    const bundleDir = path.join(artifactDir, 'bundle');
    const bundleFiles = allFiles.filter((filePath) =>
      filePath.startsWith(`${bundleDir}${path.sep}`),
    );
    const updaterArchive = findUpdaterArchive(
      bundleFiles,
      metadata.updaterArchiveSuffix,
      metadata.platform,
    );

    const signaturePath = `${updaterArchive}.sig`;
    const signature = (await readFile(signaturePath, 'utf8')).trim();

    platforms[metadata.platform] = {
      signature,
      url: `https://github.com/${repoSlug}/releases/download/${tag}/${path.basename(updaterArchive)}`,
    };
  }

  return {
    version: tag,
    notes: notes || `Release ${tag}`,
    pub_date: new Date().toISOString(),
    platforms,
  };
}

function parseArgs(argv) {
  const options = {
    artifactsRootDir: '',
    notes: '',
    output: '',
    repoSlug: '',
    tag: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    switch (arg) {
      case '--artifacts-root':
        options.artifactsRootDir = value ?? '';
        index += 1;
        break;
      case '--notes':
        options.notes = value ?? '';
        index += 1;
        break;
      case '--output':
        options.output = value ?? '';
        index += 1;
        break;
      case '--repo':
        options.repoSlug = value ?? '';
        index += 1;
        break;
      case '--tag':
        options.tag = value ?? '';
        index += 1;
        break;
      case '-h':
      case '--help':
        console.log(`Usage:
  node scripts/build-updater-json.mjs --artifacts-root <dir> --repo <owner/repo> --tag <v1.2.3> [--notes <text>] --output <latest.json>
`);
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.artifactsRootDir || !options.repoSlug || !options.tag || !options.output) {
    throw new Error('Missing required arguments.');
  }

  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await buildUpdaterManifest(options);
  await writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Generated ${options.output}`);
}
