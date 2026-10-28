/** Power-user export commands. URLs carry short-lived tokens; never include cookies. */
export const TOKEN_WARNING =
  "This URL contains a short-lived access token. Run the command soon and do not share it.";

const q = (s: string) => s.replace(/(["\\$`])/g, "\\$1");

export function ytDlpCommand(manifestUrl: string, name: string): string {
  return `yt-dlp --no-part -N 4 -o "${q(name)}.mp4" "${q(manifestUrl)}"`;
}
export function ffmpegCommand(manifestUrl: string, name: string): string {
  return `ffmpeg -i "${q(manifestUrl)}" -c copy "${q(name)}.mp4"`;
}
