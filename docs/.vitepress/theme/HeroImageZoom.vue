<script setup>
import { ref, onMounted, onUnmounted } from 'vue';

const props = defineProps({
  src: { type: String, required: true },
  alt: { type: String, default: '' },
});

const open = ref(false);
const toggle = () => (open.value = !open.value);
const close = () => (open.value = false);

const onKey = (e) => {
  if (e.key === 'Escape') close();
};

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <button
    type="button"
    class="hero-zoom-trigger"
    :aria-label="`Expand image: ${alt}`"
    @click="toggle"
  >
    <img :src="src" :alt="alt" />
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      class="hero-zoom-overlay"
      role="dialog"
      aria-modal="true"
      @click="close"
    >
      <img :src="src" :alt="alt" @click.stop />
      <button
        type="button"
        class="hero-zoom-close"
        aria-label="Close"
        @click="close"
      >
        ×
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.hero-zoom-trigger {
  display: block;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: zoom-in;
}
.hero-zoom-trigger img {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  transition: transform 0.2s ease;
}
.hero-zoom-trigger:hover img {
  transform: scale(1.02);
}

.hero-zoom-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.85);
  cursor: zoom-out;
  padding: 2rem;
}
.hero-zoom-overlay img {
  max-width: 95vw;
  max-height: 95vh;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  cursor: default;
}
.hero-zoom-close {
  position: fixed;
  top: 1rem;
  right: 1.5rem;
  width: 2.5rem;
  height: 2.5rem;
  border: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  font-size: 1.75rem;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.hero-zoom-close:hover {
  background: rgba(255, 255, 255, 0.25);
}
</style>
