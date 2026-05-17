import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import HeroImageZoom from './HeroImageZoom.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'home-hero-image': () =>
        h(HeroImageZoom, {
          src: 'https://raw.githubusercontent.com/NikiforovAll/pi-cost/main/assets/overview.png',
          alt: 'pi-cost dashboard',
        }),
    });
  },
};
