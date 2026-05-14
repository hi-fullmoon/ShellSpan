# Contributing to TermBridge

Thank you for contributing! Please follow these guidelines to ensure code quality and consistency.

## Development Environment

- **Node.js**: >=24 <25 (use nvm)
- **Package Manager**: pnpm 10.33.0
- **Rust**: latest stable (for Tauri)

```bash
# Install dependencies
pnpm install

# Start dev server
pnpm dev

# Start Tauri dev mode
pnpm tauri:dev

# Build
pnpm build

# Run tests
pnpm test
```

## Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/).

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

| Type | Purpose | Example |
|------|---------|---------|
| `feat` | new feature | `feat(term): add split pane support` |
| `fix` | bug fix | `fix(ui): resolve button click issue` |
| `docs` | documentation | `docs(readme): update install guide` |
| `style` | formatting | `style: format code` |
| `refactor` | restructuring | `refactor(store): refactor settings store` |
| `perf` | performance | `perf(term): optimize terminal rendering` |
| `test` | tests | `test(hooks): add useTerminal tests` |
| `chore` | tooling | `chore(deps): upgrade dependencies` |
| `ci` | CI config | `ci: add automated tests` |
| `build` | build system | `build: configure vite optimization` |
| `revert` | rollback | `revert: revert feat(term) split pane` |

### Scopes

- `ui` - UI components
- `term` - terminal features
- `settings` - settings panel
- `i18n` - internationalization
- `store` - Zustand stores
- `hook` - custom hooks
- `tauri` - Tauri backend/commands
- `deps` - dependency updates
- `build` - build config
- `test` - tests

### Examples

```
feat(term): add split pane support

- implement left/right split layout
- add drag-to-resize split panes
- each pane has independent session

Closes #123
```

```
fix(ui): resolve settings panel scroll lag

- remove unnecessary re-renders
- optimize with React.memo
```

```
chore(deps): upgrade React to 19.2.5
```

## Code Standards

### TypeScript

- strict mode enabled (strict: true)
- no `any`, use `unknown` + type guards
- interfaces: PascalCase (e.g. `TerminalConfig`)
- type aliases: PascalCase (e.g. `ThemeType`)

### React

- function components with arrow functions
- props types named `XxxProps` (e.g. `ButtonProps`)
- custom hooks prefixed with `use`
- complete dependency arrays in useEffect
- functional state updates

### File Organization

```
src/
  components/       # reusable UI components
    Button.tsx
    Terminal/
      index.tsx
      Terminal.tsx
      TerminalHeader.tsx
      types.ts
  hooks/            # custom hooks
    useTerminal.ts
  stores/           # Zustand stores
    settingsStore.ts
  lib/              # utility functions
    utils.ts
  types.ts          # global types
  locales/          # i18n
```

### Naming

- component files: PascalCase.tsx
- utility files: camelCase.ts
- constants: UPPER_SNAKE_CASE
- CSS classes: Tailwind first, custom classes in kebab-case

## Pre-commit Checklist

Before committing:

- [ ] `pnpm build` succeeds (tsc + vite build)
- [ ] `pnpm test` passes
- [ ] no `console.log` / `debugger` / `TODO`
- [ ] commit message follows convention
- [ ] Tauri commands tested (if `src-tauri/` modified)

## Automated Pre-commit Checks

Git Hooks are configured to automatically check:

1. **Commit message format** - must follow Conventional Commits
2. **Debug code detection** - flags console.log / debugger / TODO
3. **Large file warning** - warns on changes >500 lines
4. **TypeScript check** - runs `tsc --noEmit`
5. **Test check** - runs `pnpm test`

## Code Review

All submissions require code review. Focus areas:

### Security
- Tauri command parameter validation
- no sensitive path exposure
- terminal input sanitization

### Performance
- avoid unnecessary re-renders
- virtualize large data lists
- terminal output buffer management

### Accessibility
- keyboard navigation
- proper ARIA labels
- color contrast

## Reporting Issues

Found a bug or have a feature request? Create an issue:

1. Use a clear title
2. Describe reproduction steps (for bugs)
3. Explain expected behavior
4. Provide environment info (OS, Node version, etc.)

## License

By submitting code, you agree to license it under MIT.
