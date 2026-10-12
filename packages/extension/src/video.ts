/** The main video on the page: the largest one, preferring one that is playing. */
export function findMainVideo(
  root: ParentNode = document,
): HTMLVideoElement | null {
  const videos = [...root.querySelectorAll("video")];
  const area = (v: HTMLVideoElement) => v.clientWidth * v.clientHeight;
  videos.sort(
    (a, b) => Number(!b.paused) - Number(!a.paused) || area(b) - area(a),
  );
  return videos[0] ?? null;
}
