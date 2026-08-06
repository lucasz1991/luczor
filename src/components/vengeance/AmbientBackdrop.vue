<template>
  <div class="vz-ambient" aria-hidden="true">
    <div class="vz-ambient__halo vz-ambient__halo--one" />
    <div class="vz-ambient__halo vz-ambient__halo--two" />
    <div class="vz-ambient__beam" />
    <div class="vz-ambient__grain" />
  </div>
</template>

<style scoped>
.vz-ambient {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  background:
    radial-gradient(circle at 50% -20%, rgba(111, 92, 255, 0.15), transparent 42%),
    linear-gradient(145deg, #09090d 0%, #0c0d14 48%, #08090d 100%);
}

.vz-ambient::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    linear-gradient(rgba(255, 255, 255, 0.018) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.018) 1px, transparent 1px);
  background-size: 64px 64px;
  mask-image: radial-gradient(circle at 52% 42%, #000 0%, transparent 72%);
}

.vz-ambient::after {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at center, transparent 38%, rgba(0, 0, 0, 0.58) 100%);
}

.vz-ambient__halo {
  position: absolute;
  width: 42vw;
  aspect-ratio: 1;
  border-radius: 999px;
  filter: blur(90px);
  opacity: 0.24;
  will-change: transform;
}

.vz-ambient__halo--one {
  top: -26%;
  left: 14%;
  background: #795cff;
  animation: vz-drift-one 18s ease-in-out infinite alternate;
}

.vz-ambient__halo--two {
  right: -13%;
  bottom: -38%;
  background: #177dff;
  animation: vz-drift-two 22s ease-in-out infinite alternate;
}

.vz-ambient__beam {
  position: absolute;
  top: -30%;
  left: 51%;
  width: 18vw;
  height: 120vh;
  opacity: 0.17;
  transform: rotate(18deg);
  background: linear-gradient(90deg, transparent, rgba(159, 144, 255, 0.34), transparent);
  filter: blur(32px);
  animation: vz-beam 16s ease-in-out infinite alternate;
}

.vz-ambient__grain {
  position: absolute;
  inset: -50%;
  opacity: 0.055;
  background-image:
    repeating-radial-gradient(circle at 20% 30%, #fff 0 0.5px, transparent 0.5px 3px),
    repeating-radial-gradient(circle at 80% 70%, #fff 0 0.5px, transparent 0.5px 4px);
  background-size:
    7px 7px,
    9px 9px;
  mix-blend-mode: soft-light;
}

@keyframes vz-drift-one {
  to {
    transform: translate3d(16vw, 10vh, 0) scale(1.12);
  }
}

@keyframes vz-drift-two {
  to {
    transform: translate3d(-14vw, -12vh, 0) scale(0.9);
  }
}

@keyframes vz-beam {
  to {
    transform: translateX(-18vw) rotate(8deg);
    opacity: 0.1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .vz-ambient__halo,
  .vz-ambient__beam,
  .vz-ambient__grain {
    animation: none;
  }
}
</style>
