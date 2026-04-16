# Multi-Platform Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Actions release pipeline that publishes `windows-x86_64`, `darwin-x86_64`, and `darwin-aarch64` assets into one GitHub Release and generates a combined updater `latest.json`.

**Architecture:** GitHub Actions performs per-platform Tauri builds in parallel and uploads raw bundle directories as workflow artifacts. A final release job downloads all bundle outputs, generates a single multi-platform updater manifest, and uploads installers plus updater archives to one GitHub Release.

**Tech Stack:** GitHub Actions, Tauri CLI, pnpm, Node.js, Vitest

---

### Task 1: Add an updater manifest generator

**Files:**
- Create: `scripts/build-updater-json.mjs`
- Test: `scripts/__tests__/build-updater-json.test.mjs`

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run the targeted test to verify it fails**
- [ ] **Step 3: Implement manifest generation from bundle artifacts**
- [ ] **Step 4: Re-run the targeted test to verify it passes**

### Task 2: Add multi-platform GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `package.json`

- [ ] **Step 1: Add a matrix workflow for macOS Arm, macOS Intel, and Windows**
- [ ] **Step 2: Upload bundle directories from each build job as artifacts**
- [ ] **Step 3: Add a release aggregation job that downloads artifacts and invokes `scripts/build-updater-json.mjs`**
- [ ] **Step 4: Validate workflow syntax locally as far as possible**

### Task 3: Update local release tooling and documentation

**Files:**
- Modify: `scripts/release-github.sh`
- Modify: `README.md`

- [ ] **Step 1: Reposition the local script as a local single-machine helper and document CI as the primary release path**
- [ ] **Step 2: Document required GitHub secrets for multi-platform builds**
- [ ] **Step 3: Document the tag / workflow trigger path and expected platform outputs**
- [ ] **Step 4: Verify docs and script references are consistent**
