export const RELEASE_BASH_VERSION = '5.3';
export const BASH_READLINE_VERSIONS = Object.freeze({ '4.1': '6.0', '4.4': '7.0', '5.3': '8.3.6' });

export function bashProfileId(version, target) {
  return `gnu-bash-${version}-readline-${BASH_READLINE_VERSIONS[version]}-${target}-native`;
}
