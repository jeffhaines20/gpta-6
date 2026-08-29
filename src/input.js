// Input: keyboard + pointer-lock mouse look. Single source of truth for all
// controllers so on-foot and in-vehicle read the same axes.

export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.pressed = new Set();     // edge-triggered, cleared each frame
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.locked = false;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const c = e.code;
      this.keys.add(c);
      this.pressed.add(c);
      if (['Space', 'Tab', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(c)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    domElement.addEventListener('click', () => {
      if (!this.locked) domElement.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === domElement;
    });
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
  }

  down(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }

  // Movement axes in local space: x = strafe right, y = forward.
  moveAxis() {
    let x = 0, y = 0;
    if (this.down('KeyW')) y += 1;
    if (this.down('KeyS')) y -= 1;
    if (this.down('KeyD')) x += 1;
    if (this.down('KeyA')) x -= 1;
    const len = Math.hypot(x, y);
    return len > 1 ? { x: x / len, y: y / len } : { x, y };
  }

  endFrame() {
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}
