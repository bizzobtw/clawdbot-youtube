export async function heartbeat(status: string, task?: string) {
  console.log(`[Heartbeat] ${status}${task ? ': ' + task : ''}`);
}
export async function sendMessage(from: string, text: string) {
  console.log(`[Message] ${from}: ${text}`);
}
export async function pushTask(task: any) {
  console.log(`[Task] ${task.name}`);
}
export async function trackCost(service: string, amount: number) {
  console.log(`[Cost] ${service}: $${amount}`);
}
export async function alert(message: string, level?: string) {
  console.log(`[Alert][${level || 'info'}] ${message}`);
}
