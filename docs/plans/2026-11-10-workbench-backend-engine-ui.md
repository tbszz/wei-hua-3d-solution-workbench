# 3D Industrial Workbench Backend and Engine UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Connect the PRD-defined backend APIs to the existing ScenePlan engine and reshape the workbench so point-table selection parameters open as large cards while the left side is clearly an engine workspace.

**Architecture:** Keep the deterministic domain functions as the source of truth. Add a project-scoped API compatibility layer around the existing in-memory/file-backed ScenePlan, version history, product/fixture read APIs, file metadata storage, and deterministic job status endpoints. The browser continues to receive ScenePlan updates through SSE and uses the same tool validation path for direct viewport edits.

**Tech Stack:** Node.js, Express 5, native test runner, Vite, Three.js, Playwright.

---

### Task 1: Complete project-scoped backend API

**Files:**
- Modify: workbench/server/index.js
- Modify: workbench/server/runtime.js
- Modify: workbench/server/domain/plan.js
- Test: workbench/server/api.test.js

**Steps:**
1. Add project id normalization and project-scoped aliases for GET/PATCH plan and version history.
2. Expose /api/products and /api/fixtures with stable read-only payloads.
3. Add file metadata upload/list handling under /api/projects/:id/files without trusting client ScenePlan state.
4. Add deterministic render/record job creation and status endpoints with SSE-compatible progress payloads.
5. Persist bounded version snapshots whenever a tool changes the plan.
6. Add tests for health, product/fixture catalogs, plan aliases, invalid tool rejection, version history, file metadata, and job completion.
7. Run the focused API tests and existing server tests.

### Task 2: Engine UI and selection cards

**Files:**
- Modify: workbench/src/main.js
- Modify: workbench/src/style.css

**Steps:**
1. Make the left viewport visually dominant with engine status, controls, and a clear point-table entry.
2. Render point-table rows with buttons that open a large selection/parameter card.
3. Add accessible modal close and escape behavior, with parameter source labels and server-validated actions.
4. Preserve desktop left-engine/right-agent and mobile stacked layouts.
5. Run the Vite build and browser flow checks.

### Task 3: End-to-end integration and verification

**Files:**
- Modify only files required by failing integration checks.

**Steps:**
1. Run npm test, npm run build, and npm run test:e2e from workbench.
2. Start the server and browser, exercise project plan load, parameter card interaction, point insertion, and SSE chat flow.
3. Inspect git diff for accidental unrelated edits.
4. Report exact verification evidence and any remaining limitations.
