import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three';
import { parseCad } from '../../demo/src/scene/parse-cad.js';
import { buildTimeline } from '../../demo/src/scene/route.js';
import { Site } from '../../demo/src/scene/site.js';

test('a second AGV gets its own route-synchronised carrier', async () => {
  const text = await readFile(new URL('../../data/cad/sample-plant.dxf', import.meta.url), 'utf8');
  const site = new Site({}, {});
  site.timeline = buildTimeline(parseCad(text));
  site.cargoObjects = [];
  site.built = { stations: [] };
  site.setVehicle(new THREE.Group(), { protrusion: 0 }, { length: 2800, width: 1500, height: 381.9 });

  site.syncVehicleFleet(2);
  site.time = 0;
  site.renderPose();

  assert.equal(site.carriers.length, 2);
  assert.notDeepEqual(site.carriers[0].position.toArray(), site.carriers[1].position.toArray());
});
