# TermBridge Project Guidelines

## Project Info
- **Stack**: React 19 + TypeScript 6 + Vite 8 + Tauri 2 + Tailwind CSS 4
- **Package Manager**: pnpm 10.33.0
- **Node Version**: >=24 <25
- **Test Framework**: Vitest + @testing-library/react + jsdom

## Commit Convention

### Format
```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types
| Type | Purpose |
|------|---------|
| feat | new feature |
| fix | bug fix |
| docs | documentation |
| style | formatting (no functional change) |
| refactor | code restructuring |
| perf | performance improvement |
| test | tests |
| chore | build/tooling/dependencies |
| ci | CI/CD config |
| build | build system |
| revert | rollback |

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
- enums: PascalCase + UPPER_SNAKE_CASE values (e.g. `enum ColorScheme { DARK = 'dark' }`)
- generic params: T, K, V or meaningful names

### React
- function components with arrow functions
- props types named `XxxProps` (e.g. `ButtonProps`)
- use React.FC or explicit return type
- custom hooks prefixed with `use`
- complete dependency arrays in useEffect
- functional state updates (e.g. `setState(prev => ...)`)

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

### Prohibited
- no console.log / debugger in commits
- no TODO without corresponding issue
- no hardcoded secrets/passwords
- no unused imports
- no type errors (tsc must pass)

## Pre-commit Checklist

- [ ] `pnpm build` succeeds (tsc + vite build)
- [ ] `pnpm test` passes
- [ ] no console.log / debugger / TODO
- [ ] commit message follows convention
- [ ] Tauri commands tested (if src-tauri/ modified)

## Review Focus

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

## Tauri Specific

### Command Naming
- snake_case
- module prefix: `term_`, `settings_`, `window_`

### Error Handling
- all commands return `Result<T, String>`
- frontend handles errors uniformly

### Permissions
- principle of least privilege
- new permissions declared in capabilities
