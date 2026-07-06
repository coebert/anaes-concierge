/** Best-guess friendly name for the current device/browser. */
export function detectDeviceName(userAgent: string = navigator.userAgent): string {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "iOS device";
  if (/Android/i.test(userAgent)) return "Android device";
  if (/Mac/i.test(userAgent)) return "Mac";
  if (/Windows/i.test(userAgent)) return "Windows device";
  return "This device";
}
