import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"], forceRerunTriggers: ["assets/**", "fixtures/composition/**"],
  // The installed Babylon adapter omits .js on its Babylon imports. Resolve
  // those through Vite, as the app does, for the native measurement oracle.
  server: { deps: { inline: [/3d-tiles-renderer\//] } },
} });
