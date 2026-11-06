# PSReadLine 2.4.5-shellspan1

The native Windows providers use an application-private build of upstream
PSReadLine v2.4.5. The public module/API version remains 2.4.5; the verified
profile ID adds `shellspan1` and binds the actual assembly digest.

The reviewed patch registers a process-exit handler after native history
initialization. This fills the ordinary `exit` path that does not enter the
console-closing key loop. It calls the module's own history writer only for
SaveAtExit, retaining its sensitive-history filtering and mutex. An already
disposed mutex means the existing console-closing path has handled history.
SaveNothing and SaveIncrementally retain their original behavior.

`build.json` pins the upstream source archive, patch, .NET SDK and output bytes.
The adjacent NuGet lock files pin transitive package content. Builds normalize
source paths and omit debug records so different owned build directories
produce identical assemblies.

```text
node scripts/rebuild-psreadline.mjs
node scripts/rebuild-psreadline.mjs --install
node scripts/rebuild-psreadline.mjs --verify-only
```

Builds use unique `.artifacts/tests/dependency-builds/psreadline/` directories.
`--install` copies only verified generated assemblies and their provenance into
the bundled module. It does not install or change the user's PowerShell/module,
alter execution policy or trust, enable production profiles, or package a release.

Upstream: https://github.com/PowerShell/PSReadLine/tree/v2.4.5
