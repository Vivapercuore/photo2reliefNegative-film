import {
  Quad,
  Pt,
  bilinear,
  defaultQuad,
  stepCenters,
  whiteRefPairs,
  cellSizePx,
  sampleHalf,
  moveCorner,
  moveEdge,
  translateQuad,
} from './stripSampling';

/** A plain axis-aligned rectangle quad in TL,TR,BR,BL order. */
function rect(x0: number, y0: number, x1: number, y1: number): Quad {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const edgeVec = (q: Quad, i: number): Pt => ({
  x: q[(i + 1) % 4].x - q[i].x,
  y: q[(i + 1) % 4].y - q[i].y,
});

describe('bilinear', () => {
  const q = rect(10, 20, 110, 80);

  it('returns the four corners at the parametric corners', () => {
    expect(bilinear(q, 0, 0)).toEqual({ x: 10, y: 20 }); // TL
    expect(bilinear(q, 1, 0)).toEqual({ x: 110, y: 20 }); // TR
    expect(bilinear(q, 1, 1)).toEqual({ x: 110, y: 80 }); // BR
    expect(bilinear(q, 0, 1)).toEqual({ x: 10, y: 80 }); // BL
  });

  it('returns the centroid at u=v=0.5', () => {
    const c = bilinear(q, 0.5, 0.5);
    expect(near(c.x, 60)).toBe(true);
    expect(near(c.y, 50)).toBe(true);
  });

  it('u runs along the top/bottom edges, v from top to bottom (matches old bil)', () => {
    // sheared quad so the two axes are distinguishable
    const s: Quad = [
      { x: 0, y: 0 }, // TL
      { x: 100, y: 0 }, // TR
      { x: 120, y: 50 }, // BR
      { x: 20, y: 50 }, // BL
    ];
    // top edge midpoint
    expect(bilinear(s, 0.5, 0)).toEqual({ x: 50, y: 0 });
    // bottom edge midpoint
    expect(bilinear(s, 0.5, 1)).toEqual({ x: 70, y: 50 });
    // left edge midpoint (u=0)
    expect(bilinear(s, 0, 0.5)).toEqual({ x: 10, y: 25 });
  });
});

describe('defaultQuad', () => {
  it('is an axis-aligned rectangle, centred, 70% wide with ~square steps', () => {
    const w = 1000;
    const h = 800;
    const q = defaultQuad(w, h);
    const bw = q[1].x - q[0].x;
    const bh = q[3].y - q[0].y;
    expect(near(bw, 0.7 * w)).toBe(true); // 70% of width
    expect(near(bh, bw / 7)).toBe(true); // step ≈ square
    // axis aligned
    expect(near(q[0].y, q[1].y)).toBe(true);
    expect(near(q[2].y, q[3].y)).toBe(true);
    expect(near(q[0].x, q[3].x)).toBe(true);
    expect(near(q[1].x, q[2].x)).toBe(true);
    // centred
    expect(near((q[0].x + q[1].x) / 2, w / 2)).toBe(true);
    expect(near((q[0].y + q[3].y) / 2, h / 2)).toBe(true);
  });

  it('stays inside the image bounds', () => {
    const cases: [number, number][] = [
      [1000, 800],
      [200, 1200], // tall & narrow: 70% width would give a very tall box
      [400, 90], // short: reserve constraint dominates
    ];
    for (const [w, h] of cases) {
      const q = defaultQuad(w, h);
      for (const p of q) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(w);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(h);
      }
    }
  });

  it('leaves >= 20% image height clear above and below the box', () => {
    const cases: [number, number][] = [
      [1000, 800],
      [200, 1200],
      [400, 90],
      [640, 480],
    ];
    for (const [w, h] of cases) {
      const q = defaultQuad(w, h);
      const top = q[0].y;
      const bottom = q[3].y;
      expect(top).toBeGreaterThanOrEqual(0.2 * h - 1e-6);
      expect(h - bottom).toBeGreaterThanOrEqual(0.2 * h - 1e-6);
    }
  });
});

describe('stepCenters', () => {
  const q = rect(0, 0, 700, 100);

  it('produces exactly n centres', () => {
    expect(stepCenters(q, 7)).toHaveLength(7);
    expect(stepCenters(q, 3)).toHaveLength(3);
  });

  it('has strictly increasing x and stays inside the box vertically', () => {
    const cs = stepCenters(q, 7);
    for (let i = 1; i < cs.length; i++) expect(cs[i].x).toBeGreaterThan(cs[i - 1].x);
    for (const c of cs) {
      expect(c.x).toBeGreaterThan(0);
      expect(c.x).toBeLessThan(700);
      expect(near(c.y, 50)).toBe(true); // v=0.5 → vertical centre
    }
  });
});

describe('whiteRefPairs', () => {
  const q = rect(0, 100, 700, 200); // box from y=100..200, height 100
  const n = 7;
  const off = 0.5;

  it('places above/below symmetric about the box and honours offFrac', () => {
    const pairs = whiteRefPairs(q, n, off);
    expect(pairs).toHaveLength(n);
    const boxH = 100;
    for (let j = 0; j < n; j++) {
      const u = (j + 0.5) / n;
      const cx = bilinear(q, u, 0.5).x;
      // shares the column x with the step centre
      expect(near(pairs[j].above.x, cx)).toBe(true);
      expect(near(pairs[j].below.x, cx)).toBe(true);
      // above at v=-off → off*boxH above the top edge (y=100)
      expect(near(pairs[j].above.y, 100 - off * boxH)).toBe(true);
      // below at v=1+off → off*boxH below the bottom edge (y=200)
      expect(near(pairs[j].below.y, 200 + off * boxH)).toBe(true);
      // symmetric about the box centre (y=150)
      expect(near((pairs[j].above.y + pairs[j].below.y) / 2, 150)).toBe(true);
    }
  });

  it('a larger offFrac pushes the references further out', () => {
    const p1 = whiteRefPairs(q, n, 0.3);
    const p2 = whiteRefPairs(q, n, 0.8);
    expect(p2[0].above.y).toBeLessThan(p1[0].above.y);
    expect(p2[0].below.y).toBeGreaterThan(p1[0].below.y);
  });
});

describe('cellSizePx / sampleHalf', () => {
  it('cellSizePx: width = top length / n, height = left length', () => {
    const q = rect(0, 0, 700, 120);
    const { w, h } = cellSizePx(q, 7);
    expect(near(w, 100)).toBe(true);
    expect(near(h, 120)).toBe(true);
  });

  it('sampleHalf is a quarter of the smaller cell dimension', () => {
    const q = rect(0, 0, 700, 120); // cellW=100, cellH=120 → min 100 → 25
    expect(near(sampleHalf(q, 7), 25)).toBe(true);
  });

  it('sampleHalf never drops below 2 for a tiny box', () => {
    const q = rect(0, 0, 7, 1); // cellW=1, cellH=1 → 0.25 → floored to 2
    expect(sampleHalf(q, 7)).toBe(2);
  });
});

describe('moveCorner', () => {
  const w = 200;
  const h = 100;
  const q = rect(10, 10, 110, 60);

  it('moves only the targeted corner and leaves the rest untouched', () => {
    const next = moveCorner(q, 0, 30, 25, w, h);
    expect(next[0]).toEqual({ x: 30, y: 25 });
    expect(next[1]).toEqual(q[1]);
    expect(next[2]).toEqual(q[2]);
    expect(next[3]).toEqual(q[3]);
  });

  it('clamps the moved corner to the image bounds', () => {
    const next = moveCorner(q, 2, 999, -50, w, h);
    expect(next[2]).toEqual({ x: 200, y: 0 });
  });

  it('does not mutate the input quad', () => {
    const snapshot = JSON.stringify(q);
    moveCorner(q, 0, 30, 25, w, h);
    expect(JSON.stringify(q)).toBe(snapshot);
  });
});

describe('moveEdge', () => {
  const w = 200;
  const h = 100;
  const q = rect(20, 20, 120, 70);

  it('translates both edge corners together, preserving the edge vector', () => {
    const before = edgeVec(q, 0);
    const next = moveEdge(q, 0, 15, 10, w, h);
    const after = edgeVec(next, 0);
    expect(near(after.x, before.x)).toBe(true);
    expect(near(after.y, before.y)).toBe(true);
    expect(next[0]).toEqual({ x: 35, y: 30 });
    expect(next[1]).toEqual({ x: 135, y: 30 });
  });

  it('shrinks an out-of-bounds delta so BOTH corners stay in and the edge is undeformed', () => {
    // push edge 0 (top: corners 0 and 1) far up/left, past the bounds
    const before = edgeVec(q, 0);
    const next = moveEdge(q, 0, -999, -999, w, h);
    const after = edgeVec(next, 0);
    // edge vector unchanged → no deformation
    expect(near(after.x, before.x)).toBe(true);
    expect(near(after.y, before.y)).toBe(true);
    // all corners still in bounds
    for (const p of next) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(w);
      expect(p.y).toBeLessThanOrEqual(h);
    }
    // the limiting corner sits exactly on the boundary (leftmost x=20 → 0)
    expect(near(Math.min(next[0].x, next[1].x), 0)).toBe(true);
    expect(near(Math.min(next[0].y, next[1].y), 0)).toBe(true);
  });

  it('does not mutate the input quad', () => {
    const snapshot = JSON.stringify(q);
    moveEdge(q, 1, 999, 999, w, h);
    expect(JSON.stringify(q)).toBe(snapshot);
  });
});

describe('translateQuad', () => {
  const w = 200;
  const h = 100;
  const q = rect(20, 20, 120, 70);

  it('translates all four corners by the same delta', () => {
    const next = translateQuad(q, 10, 5, w, h);
    for (let i = 0; i < 4; i++) {
      expect(near(next[i].x, q[i].x + 10)).toBe(true);
      expect(near(next[i].y, q[i].y + 5)).toBe(true);
    }
  });

  it('shrinks an out-of-bounds delta so no corner leaves and shape is preserved', () => {
    const beforeEdges = [0, 1, 2, 3].map((i) => edgeVec(q, i));
    const next = translateQuad(q, 999, -999, w, h);
    // shape preserved: every edge vector identical
    const afterEdges = [0, 1, 2, 3].map((i) => edgeVec(next, i));
    afterEdges.forEach((e, i) => {
      expect(near(e.x, beforeEdges[i].x)).toBe(true);
      expect(near(e.y, beforeEdges[i].y)).toBe(true);
    });
    // in bounds
    for (const p of next) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(w);
      expect(p.y).toBeLessThanOrEqual(h);
    }
    // rightmost corner pinned to x=w (120→200 means +80 was the max +x shift)
    expect(near(Math.max(next[0].x, next[1].x), w)).toBe(true);
    expect(near(Math.min(next[0].y, next[3].y), 0)).toBe(true);
  });

  it('does not mutate the input quad', () => {
    const snapshot = JSON.stringify(q);
    translateQuad(q, 5, 5, w, h);
    expect(JSON.stringify(q)).toBe(snapshot);
  });
});
