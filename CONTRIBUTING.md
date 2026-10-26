# Contributing

Thank you for contributing! Please follow these guidelines to maintain code quality and consistency.

## Development Environment

- **Node.js**: >=24 (see `package.json`; nvm recommended)
- **Package manager**: pnpm 11.1.1 (see `packageManager` in `package.json`)
- **Rust**: latest stable (for Tauri)

```bash
# Install dependencies
pnpm install

# Start the development server
pnpm dev

# Start Tauri in development mode
pnpm tauri:dev

# Build
pnpm build

# Run tests
pnpm test
```

## Commit Guidelines

> **Note**: All Git commit messages must be written in English.

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification.

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

| Type | Purpose | Example |
|------|------|------|
| `feat` | New features | `feat(term): add split pane support` |
| `fix` | Bug fixes | `fix(ui): resolve button click issue` |
| `docs` | Documentation updates | `docs(readme): update install guide` |
| `style` | Code formatting | `style: format code` |
| `refactor` | Code refactoring | `refactor(store): refactor settings store` |
| `perf` | Performance improvements | `perf(term): optimize terminal rendering` |
| `test` | Tests | `test(hooks): add useTerminal tests` |
| `chore` | Tooling and maintenance | `chore(deps): upgrade dependencies` |
| `ci` | CI configuration | `ci: add automated tests` |
| `build` | Build system | `build: configure vite optimization` |
| `revert` | Reverts | `revert: revert feat(term) split pane` |

### Scopes

- `ui` - UI components
- `term` - Terminal features
- `settings` - Settings panel
- `i18n` - Internationalization
- `store` - Zustand stores
- `hook` - Custom hooks
- `tauri` - Tauri backend and commands
- `deps` - Dependency updates
- `build` - Build configuration
- `test` - Tests

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

## Coding Standards

### TypeScript

- Enable strict mode (`strict: true`).
- Do not use `any`; use `unknown` with type guards.
- Use PascalCase for interfaces (e.g., `TerminalConfig`).
- Use PascalCase for type aliases (e.g., `ThemeType`).

### React

- Use arrow functions for function components.
- Name props types `XxxProps` (e.g., `ButtonProps`).
- Prefix custom hooks with `use`.
- Include all dependencies in `useEffect` dependency arrays.
- Use functional state updates.

### File Organization

```
src/
  components/       # Reusable UI components
    Button.tsx
    Terminal/
      index.tsx
      Terminal.tsx
      TerminalHeader.tsx
      types.ts
  hooks/            # Custom hooks
    useTerminal.ts
  stores/           # Zustand stores
    settingsStore.ts
  lib/              # Utilities
    utils.ts
  types.ts          # Global types
  locales/          # Internationalization
```

### Naming Conventions

- Component files: PascalCase.tsx
- Utility files: camelCase.ts
- Constants: UPPER_SNAKE_CASE
- CSS classes: prefer Tailwind; use kebab-case for custom classes.

## Pre-commit Checklist

Before committing, confirm that:

- [ ] `pnpm build` succeeds (tsc + vite build).
- [ ] `pnpm test` passes.
- [ ] No `console.log` / `debugger` / `TODO` remains.
- [ ] The commit message follows the guidelines.
- [ ] Tauri commands have been tested (if `src-tauri/` was modified).

## Automated Pre-commit Checks

Git hooks are configured to perform these checks automatically:

1. **Commit message format** - Require Conventional Commits.
2. **Debug code detection** - Flag console.log / debugger / TODO.
3. **Large change warning** - Warn when changes exceed 500 lines.
4. **TypeScript check** - Run `tsc --noEmit`.

## Code Review

See the [release process](./docs/releasing.md) for publishing releases, maintaining the changelog, and handling failed releases.

All contributions require code review. Reviews focus on:

### Security
- Validate Tauri command arguments.
- Do not expose sensitive paths.
- Sanitize terminal input.

### Performance
- Avoid unnecessary re-renders.
- Use virtualization for large lists.
- Manage terminal output buffers.

### Accessibility
- Keyboard navigation
- Correct ARIA labels
- Color contrast

## Reporting Issues

Found a bug or have a feature suggestion? Open an issue:

1. Use a clear title.
2. Describe the steps to reproduce (for bugs).
3. Explain the expected behavior.
4. Include environment details (operating system, Node.js version, etc.).

## License

By contributing code, you agree to license your contributions under the MIT License.
