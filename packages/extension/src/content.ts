import { defaultDriftConfig } from "@wps/sync-core";
import { findMainVideo } from "./video";

// Skeleton: find the video and report it. Sync wiring lands in milestone 3.
const video = findMainVideo();
if (video) {
  console.debug("[watch-party-sync] found video", {
    src: video.currentSrc,
    deadbandSec: defaultDriftConfig.deadbandSec,
  });
}
