export type Point = {x:number;y:number};
export function intersects(a:Point,b:Point,c:Point,r:number){
 const dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy;
 const t=l?Math.max(0,Math.min(1,((c.x-a.x)*dx+(c.y-a.y)*dy)/l)):0;
 return Math.hypot(a.x+t*dx-c.x,a.y+t*dy-c.y)<=r;
}
