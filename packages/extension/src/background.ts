// Service worker. Will own the WebSocket to the sync server and relay to
// content scripts in every frame.
chrome.runtime.onInstalled.addListener(() => {
  console.debug("[watch-party-sync] installed");
});
