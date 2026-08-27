# Desktop modules

The renderer shell owns window/project lifecycle and layout. User-facing
features register into it as modules, mirroring the backend microkernel rather
than adding another import and conditional to `App.tsx`.

A module is a default-exported object:

```tsx
const review: DesktopModule<DesktopHost> = {
  id: "review",
  requires: ["code"],
  activate(ctx) {
    ctx.registerMode({
      id: "review",
      label: "Review",
      splitId: "shell-review",
      sidebar: ReviewFiles,
      panel: ReviewPanel,
    });
  },
};

export default review;
```

Add its dynamic loader to `defaults.ts`. Modules may contribute modes,
overlays, and toolbar controls. Registrations and `ctx.effect(...)` cleanups
belong to the registering module and are unwound in reverse order if activation
fails.

Each loader becomes a separate Vite chunk. An import or activation failure is
reported in the toolbar and can be retried without taking down other modules.
Every rendered contribution also has its own error boundary, so a render fault
replaces only that feature's surface with a retry control. The root boundary is
the final fallback for bugs in the shell itself.
