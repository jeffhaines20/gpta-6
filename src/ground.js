// Flat-block test ground. In Phase 2 this interface (heightAt / raycastDown) is
// what the streaming world must implement, so the vehicle and player never learn
// how the world is actually stored.

export class FlatGround {
  constructor(height = 0) { this.h = height; }
  heightAt() { return this.h; }
  raycastDown(origin, maxDist) {
    const d = origin.y - this.h;
    if (d < 0 || d > maxDist) return null;
    return { y: this.h, normalY: 1 };
  }
}
