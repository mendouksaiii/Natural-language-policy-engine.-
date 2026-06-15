/* ============================================================
   SENTINEL — Spiral intro animation
   Vanilla port of a GSAP/canvas spiral (originally a React/TSX
   component), recoloured to the SENTINEL palette: an amber core
   spiral throwing off cyan / sky / cream sparks, with additive
   glow on deep navy. Depends on global `gsap` (vendor/gsap.min.js).
   Exposes window.SentinelSpiral.mount(canvas) / .destroy().
   ============================================================ */
(function () {
  'use strict';

  // ── Palette ──────────────────────────────────────────────
  const BG = '#070f16';
  const TRAIL = '#ffc078';      // warm amber spiral core
  const START_DOT = '#f4a24c';  // amber origin
  const STAR_COLORS = [
    '#57e0d8', '#57e0d8', '#8fcde8', '#8fcde8', // cyan / sky (most)
    '#f3ead6',                                   // cream
    '#f4a24c'                                    // amber accent
  ];

  class Vector2D {
    constructor(x, y) { this.x = x; this.y = y; }
    static random(min, max) { return min + Math.random() * (max - min); }
  }
  class Vector3D {
    constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  }

  class AnimationController {
    constructor(canvas, ctx, dpr, size) {
      this.canvas = canvas; this.ctx = ctx; this.dpr = dpr; this.size = size;
      this.time = 0;
      this.stars = [];

      this.changeEventTime = 0.32;
      this.cameraZ = -400;
      this.cameraTravelDistance = 3400;
      this.startDotYOffset = 28;
      this.viewZoom = 100;
      this.numberOfStars = 5000;
      this.trailLength = 80;

      this.timeline = gsap.timeline({ repeat: -1 });
      this.setupRandomGenerator();
      this.createStars();
      this.setupTimeline();
    }

    // Deterministic first pass (seeded) for a stable spiral skeleton,
    // then a random pass for organic variation — matches the source.
    setupRandomGenerator() {
      const originalRandom = Math.random;
      const customRandom = () => {
        let seed = 1234;
        return () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
      };
      Math.random = customRandom();
      this.createStars();
      Math.random = originalRandom;
    }

    createStars() {
      for (let i = 0; i < this.numberOfStars; i++) {
        this.stars.push(new Star(this.cameraZ, this.cameraTravelDistance));
      }
    }

    setupTimeline() {
      this.timeline.to(this, {
        time: 1, duration: 15, repeat: -1, ease: 'none',
        onUpdate: () => this.render()
      });
    }

    ease(p, g) {
      return p < 0.5 ? 0.5 * Math.pow(2 * p, g) : 1 - 0.5 * Math.pow(2 * (1 - p), g);
    }
    easeOutElastic(x) {
      const c4 = (2 * Math.PI) / 4.5;
      if (x <= 0) return 0; if (x >= 1) return 1;
      return Math.pow(2, -8 * x) * Math.sin((x * 8 - 0.75) * c4) + 1;
    }
    map(v, a1, b1, a2, b2) { return a2 + (b2 - a2) * ((v - a1) / (b1 - a1)); }
    constrain(v, min, max) { return Math.min(Math.max(v, min), max); }
    lerp(a, b, t) { return a * (1 - t) + b * t; }

    spiralPath(p) {
      p = this.constrain(1.2 * p, 0, 1);
      p = this.ease(p, 1.8);
      const turns = 6;
      const theta = 2 * Math.PI * turns * Math.sqrt(p);
      const r = 170 * Math.sqrt(p);
      return new Vector2D(r * Math.cos(theta), r * Math.sin(theta) + this.startDotYOffset);
    }

    rotate(v1, v2, p, orientation) {
      const mid = new Vector2D((v1.x + v2.x) / 2, (v1.y + v2.y) / 2);
      const dx = v1.x - mid.x, dy = v1.y - mid.y;
      const angle = Math.atan2(dy, dx);
      const o = orientation ? -1 : 1;
      const r = Math.sqrt(dx * dx + dy * dy);
      const bounce = Math.sin(p * Math.PI) * 0.05 * (1 - p);
      return new Vector2D(
        mid.x + r * (1 + bounce) * Math.cos(angle + o * Math.PI * this.easeOutElastic(p)),
        mid.y + r * (1 + bounce) * Math.sin(angle + o * Math.PI * this.easeOutElastic(p))
      );
    }

    showProjectedDot(position, sizeFactor) {
      const t2 = this.constrain(this.map(this.time, this.changeEventTime, 1, 0, 1), 0, 1);
      const newCameraZ = this.cameraZ + this.ease(Math.pow(t2, 1.2), 1.8) * this.cameraTravelDistance;
      if (position.z > newCameraZ) {
        const depth = position.z - newCameraZ;
        const x = this.viewZoom * position.x / depth;
        const y = this.viewZoom * position.y / depth;
        const sw = 400 * sizeFactor / depth;
        this.ctx.lineWidth = sw;
        this.ctx.beginPath();
        this.ctx.arc(x, y, 0.5, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }

    drawStartDot() {
      if (this.time > this.changeEventTime) {
        const dy = this.cameraZ * this.startDotYOffset / this.viewZoom;
        this.ctx.fillStyle = START_DOT;
        this.showProjectedDot(new Vector3D(0, dy, this.cameraTravelDistance), 2.5);
      }
    }

    render() {
      const ctx = this.ctx;
      if (!ctx) return;

      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, this.size, this.size);

      ctx.save();
      ctx.translate(this.size / 2, this.size / 2);
      ctx.globalCompositeOperation = 'lighter'; // additive glow

      const t1 = this.constrain(this.map(this.time, 0, this.changeEventTime + 0.25, 0, 1), 0, 1);
      const t2 = this.constrain(this.map(this.time, this.changeEventTime, 1, 0, 1), 0, 1);

      ctx.rotate(-Math.PI * this.ease(t2, 2.7));

      this.drawTrail(t1);

      for (const star of this.stars) star.render(t1, this);

      this.drawStartDot();

      ctx.restore(); // resets transform + composite op
    }

    drawTrail(t1) {
      this.ctx.fillStyle = TRAIL;
      for (let i = 0; i < this.trailLength; i++) {
        const f = this.map(i, 0, this.trailLength, 1.1, 0.1);
        const sw = (1.3 * (1 - t1) + 3.0 * Math.sin(Math.PI * t1)) * f;
        this.ctx.lineWidth = sw;

        const pathTime = t1 - 0.00015 * i;
        const basePos = this.spiralPath(pathTime);
        const offset = new Vector2D(basePos.x + 5, basePos.y + 5);
        const rotated = this.rotate(
          basePos, offset,
          Math.sin(this.time * Math.PI * 2) * 0.5 + 0.5,
          i % 2 === 0
        );
        this.ctx.beginPath();
        this.ctx.arc(rotated.x, rotated.y, sw / 2, 0, Math.PI * 2);
        this.ctx.fill();
      }
    }

    pause() { this.timeline.pause(); }
    resume() { this.timeline.play(); }
    destroy() { this.timeline.kill(); }
  }

  class Star {
    constructor(cameraZ, cameraTravelDistance) {
      this.angle = Math.random() * Math.PI * 2;
      this.distance = 30 * Math.random() + 15;
      this.rotationDirection = Math.random() > 0.5 ? 1 : -1;
      this.expansionRate = 1.2 + Math.random() * 0.8;
      this.finalScale = 0.7 + Math.random() * 0.6;
      this.color = STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length)];

      this.dx = this.distance * Math.cos(this.angle);
      this.dy = this.distance * Math.sin(this.angle);

      this.spiralLocation = (1 - Math.pow(1 - Math.random(), 3.0)) / 1.3;
      this.z = Vector2D.random(0.5 * cameraZ, cameraTravelDistance + cameraZ);
      const lerp = (a, b, t) => a * (1 - t) + b * t;
      this.z = lerp(this.z, cameraTravelDistance / 2, 0.3 * this.spiralLocation);
      this.strokeWeightFactor = Math.pow(Math.random(), 2.0);
    }

    render(p, c) {
      const spiralPos = c.spiralPath(this.spiralLocation);
      const q = p - this.spiralLocation;
      if (q <= 0) return;

      const dp = c.constrain(4 * q, 0, 1);
      const elasticEasing = c.easeOutElastic(dp);
      const powerEasing = Math.pow(dp, 2);
      let easing;
      if (dp < 0.3) easing = c.lerp(dp, powerEasing, dp / 0.3);
      else if (dp < 0.7) easing = c.lerp(powerEasing, elasticEasing, (dp - 0.3) / 0.4);
      else easing = elasticEasing;

      let screenX, screenY;
      if (dp < 0.3) {
        screenX = c.lerp(spiralPos.x, spiralPos.x + this.dx * 0.3, easing / 0.3);
        screenY = c.lerp(spiralPos.y, spiralPos.y + this.dy * 0.3, easing / 0.3);
      } else if (dp < 0.7) {
        const mid = (dp - 0.3) / 0.4;
        const curve = Math.sin(mid * Math.PI) * this.rotationDirection * 1.5;
        const baseX = spiralPos.x + this.dx * 0.3, baseY = spiralPos.y + this.dy * 0.3;
        const targetX = spiralPos.x + this.dx * 0.7, targetY = spiralPos.y + this.dy * 0.7;
        const perpX = -this.dy * 0.4 * curve, perpY = this.dx * 0.4 * curve;
        screenX = c.lerp(baseX, targetX, mid) + perpX * mid;
        screenY = c.lerp(baseY, targetY, mid) + perpY * mid;
      } else {
        const fin = (dp - 0.7) / 0.3;
        const baseX = spiralPos.x + this.dx * 0.7, baseY = spiralPos.y + this.dy * 0.7;
        const targetDistance = this.distance * this.expansionRate * 1.5;
        const spiralAngle = this.angle + 1.2 * this.rotationDirection * fin * Math.PI;
        const targetX = spiralPos.x + targetDistance * Math.cos(spiralAngle);
        const targetY = spiralPos.y + targetDistance * Math.sin(spiralAngle);
        screenX = c.lerp(baseX, targetX, fin);
        screenY = c.lerp(baseY, targetY, fin);
      }

      const vx = (this.z - c.cameraZ) * screenX / c.viewZoom;
      const vy = (this.z - c.cameraZ) * screenY / c.viewZoom;
      const position = new Vector3D(vx, vy, this.z);

      let sizeMul = 1.0;
      if (dp < 0.6) sizeMul = 1.0 + dp * 0.2;
      else { const t = (dp - 0.6) / 0.4; sizeMul = 1.2 * (1.0 - t) + this.finalScale * t; }

      c.ctx.fillStyle = this.color;
      c.showProjectedDot(position, 8.5 * this.strokeWeightFactor * sizeMul);
    }
  }

  // ── Public mount API (replaces the React component) ──────
  let controller = null;
  let onResize = null;

  function size(canvas) {
    const w = window.innerWidth, h = window.innerHeight;
    const s = Math.max(w, h);
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    canvas.width = s * dpr; canvas.height = s * dpr;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    return { ctx, dpr, s };
  }

  window.SentinelSpiral = {
    mount(canvas) {
      if (typeof gsap === 'undefined') { console.warn('[spiral] gsap not loaded'); return; }
      const { ctx, dpr, s } = size(canvas);
      controller = new AnimationController(canvas, ctx, dpr, s);
      onResize = () => {
        if (!controller) return;
        const { ctx, dpr, s } = size(canvas);
        controller.ctx = ctx; controller.dpr = dpr; controller.size = s;
      };
      window.addEventListener('resize', onResize);
      return controller;
    },
    destroy() {
      if (onResize) window.removeEventListener('resize', onResize);
      if (controller) { controller.destroy(); controller = null; }
    }
  };
})();
