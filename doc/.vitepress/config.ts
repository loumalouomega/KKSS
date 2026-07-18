import { defineConfig } from 'vitepress'

const repo = 'https://github.com/loumalouomega/KKSS'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'KKSS',
  description:
    'Keep Kratos Simple Stupid — a cross-platform desktop application for pre- and post-processing Kratos Multiphysics simulations, built on the CAD-Preview and VSCode-MDPA-Preview extensions.',
  lang: 'en-US',

  // Deployed as a GitHub *project page* at
  // https://loumalouomega.github.io/KKSS/
  base: '/KKSS/',
  cleanUrls: true,
  lastUpdated: true,

  // localhost URLs (e.g. the Docker/noVNC quickstart) are runtime endpoints,
  // not site pages — don't fail the build on them.
  ignoreDeadLinks: [/^https?:\/\/localhost/],

  themeConfig: {
    nav: [
      { text: 'Download', link: '/download' },
      { text: 'Getting Started', link: '/guide/getting-started' },
      {
        text: 'Guide',
        items: [
          { text: 'Pre-Processing (CAD) Mode', link: '/guide/cad-mode' },
          { text: 'Post-Processing (Mesh) Mode', link: '/guide/mesh-mode' },
          { text: 'File Formats', link: '/guide/file-formats' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Web Deployment (Docker)', link: '/guide/web-deployment' }
        ]
      },
      { text: 'Development', link: '/guide/development' },
      { text: 'GitHub', link: repo }
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Download', link: '/download' },
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Pre-Processing (CAD) Mode', link: '/guide/cad-mode' },
          { text: 'Post-Processing (Mesh) Mode', link: '/guide/mesh-mode' },
          { text: 'File Formats', link: '/guide/file-formats' },
          { text: 'Configuration', link: '/guide/configuration' }
        ]
      },
      {
        text: 'Development',
        items: [
          { text: 'Architecture & Building', link: '/guide/development' },
          { text: 'Web Deployment (Docker)', link: '/guide/web-deployment' }
        ]
      }
    ],

    socialLinks: [{ icon: 'github', link: repo }],

    footer: {
      message: 'Released under the AGPL-3.0 License.',
      copyright: '© Vicente Mataix Ferrándiz'
    },

    search: { provider: 'local' }
  }
})
