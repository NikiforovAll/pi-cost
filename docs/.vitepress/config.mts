import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'pi-cost',
  description: 'Cost dashboard for the pi coding agent.',
  base: '/pi-cost/docs/',
  cleanUrls: true,
  ignoreDeadLinks: true,
  appearance: 'dark',
  themeConfig: {
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
