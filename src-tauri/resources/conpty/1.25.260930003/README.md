# Private native-input console host

Unmodified x64 binaries from the Microsoft-signed `Microsoft.Windows.Console.ConPTY`
NuGet package `1.25.260930003` (MIT). `pin.json` records the package URL and SHA-256
of the package and extracted files. Validate the downloaded package with
`dotnet nuget verify --all`, then extract `runtimes/win-x64/native/conpty.dll` and
`build/native/runtimes/x64/OpenConsole.exe` to the paths in this directory.
`LICENSE` is the Microsoft Terminal MIT license.

The verified Windows native-input profile embeds these inputs in the backend,
extracts and verifies a content-addressed private cache, and passes the absolute
DLL path to portable-pty. It uses the redistributable's `Conpty*` exports and
`PSEUDOCONSOLE_GLYPH_WIDTH_GRAPHEMES` (0x08). Creation, resize and close retain
the same loaded API. A missing export or modified file fails closed.

The profile advertises session-scoped xterm `15-graphemes` measurement only after
local binary verification. Raw/legacy sessions retain the default system host.
No system installation or production packaging/resource mapping is required.
Production admission remains controlled by the existing profile policy.
