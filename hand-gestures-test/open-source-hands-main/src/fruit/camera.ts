export async function listCameras(){
 if(!navigator.mediaDevices?.enumerateDevices)return [];
 return (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');
}
export function cameraError(error:unknown){
 const e=error as Error;
 if(e.name==='NotReadableError'||e.name==='TrackStartError')return '摄像头无法输出画面。可能被其他程序占用，或默认摄像头不可用。请关闭占用摄像头的程序，并在上方选择另一台摄像头后重试。';
 if(e.name==='NotAllowedError')return '摄像头访问被拒绝。请在地址栏的网站权限中允许摄像头，然后重试。';
 if(e.name==='NotFoundError')return '未找到摄像头。请检查连接后点击刷新设备。';
 return `启动失败：${e.message}。可选择其他摄像头重试。`;
}
