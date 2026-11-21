import {expect,it} from 'vitest';
import {intersects} from '../src/fruit/rules';
it('detects a fast swipe crossing a fruit even when both endpoints miss',()=>{expect(intersects({x:0,y:50},{x:200,y:50},{x:100,y:50},20)).toBe(true);});
it('rejects misses and handles a stationary fingertip',()=>{expect(intersects({x:0,y:0},{x:200,y:0},{x:100,y:50},20)).toBe(false);expect(intersects({x:0,y:0},{x:0,y:0},{x:100,y:50},20)).toBe(false);});
