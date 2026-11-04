import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "worker" },
    }),
  ],
  environments: {
    worker: {
      build: {
        sourcemap: true,
      },
    },
  },
  // Production bundling keeps Vite's default `build.target`
  // ("baseline-widely-available" = Chrome 111, Edge 111, Firefox 114,
  // Safari/iOS 16.4), which applies to every environment. It is not set
  // explicitly here to avoid duplicating a policy Vite already owns; the
  // development server keeps its own transform target.
});
