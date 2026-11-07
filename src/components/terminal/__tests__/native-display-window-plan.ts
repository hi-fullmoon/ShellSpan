export interface DisplayWindowRect {x: number; y: number; width: number; height: number}
/** Physical client bounds must fit the work area excluding the taskbar. */
export function nativeDisplayWindowContained(workArea: DisplayWindowRect, client: DisplayWindowRect): boolean {
  if (![workArea.x, workArea.y, client.x, client.y].every(Number.isInteger)
    || ![workArea.width, workArea.height, client.width, client.height].every(value => Number.isInteger(value) && value > 0)) return false;
  return client.x >= workArea.x && client.y >= workArea.y && client.x + client.width <= workArea.x + workArea.width
    && client.y + client.height <= workArea.y + workArea.height;
}
