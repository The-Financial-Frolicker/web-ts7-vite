/**
 * Application-owned Vite configuration — declarative values only.
 *
 * The plugin policy is toolchain-owned (scripts/vite-runner.mjs): the toolchain
 * supplies `root`, disables this file as Vite's config source and injects the
 * Cloudflare plugin, discarding any `plugins` declared here. This file therefore
 * carries no imports and no plugins, so it cannot silently replace the
 * integration the build, development and preview servers share.
 *
 * Production bundling keeps Vite's default `build.target`
 * ("baseline-widely-available" = Chrome 111, Edge 111, Firefox 114,
 * Safari/iOS 16.4), which applies to every environment. It is not set
 * explicitly here to avoid duplicating a policy Vite already owns; the
 * development server keeps its own transform target.
 */
export default {
  environments: {
    worker: {
      build: {
        sourcemap: true,
      },
    },
  },
};
