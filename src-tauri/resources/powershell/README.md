# Windows PowerShell native editor

ShellSpan provides PSReadLine 2.4.5 only to its Windows PowerShell sessions by
prepending an application-owned, content-addressed module directory to the
child process's PSModulePath. System modules, parent environment and user
profiles are not edited. Profiles keep their normal startup order and can
configure the loaded module.

Upstream: https://www.powershellgallery.com/packages/PSReadLine/2.4.5

Original nupkg SHA-256:
`cb9390e9733208456c234a7971d1ec4a917886c239502aab68f4b71aa4bba235`

The DLLs, upstream PSReadLine.psm1, format data and License.txt are extracted
without modification. The application manifest uses ShellSpan.PSReadLine.psm1
to dot-source a byte-identical Upstream.PSReadLine.ps1 copy and keep Windows PowerShell's former no-prediction default
before user profiles run. The BSD 2-Clause license accompanies the embedded module.

This dependency avoids PSReadLine 2.0's narrow-console multiline rendering
failures without replacing its native editor or suppressing syntax colors.
PowerShell 7 continues to use its existing module and preferences.
