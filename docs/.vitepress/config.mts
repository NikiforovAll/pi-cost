import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'pi-cost',
  description: 'Cost dashboard for the pi coding agent.',
  base: '/pi-cost/',
  cleanUrls: true,
  ignoreDeadLinks: true,
  appearance: 'dark',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/pi-cost/icons/icon.svg' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/pi-cost/icons/icon-192.png' }],
  ],
  themeConfig: {
    logo: '/icons/icon.svg',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'User Guide', link: '/user-guide' },
      { text: 'Theming', link: '/theming' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'User Guide', link: '/user-guide' },
          { text: 'Theming', link: '/theming' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/NikiforovAll/pi-cost' },
    ],
    editLink: {
      pattern: 'https://github.com/NikiforovAll/pi-cost/edit/main/docs/:path',
    },
  },
});
