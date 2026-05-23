#!/usr/bin/env bash
# Assemble the shared-brainstorm promo from captured GIFs/PNGs + narration.
set -euo pipefail
cd "$(dirname "$0")"

FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
BG=0x0d1117
FPS=30
W=1920; H=1080
mkdir -p clips aud

# Per-scene durations = narration length + 0.6s tail (freeze / silence)
declare -A DUR=( [1]=9.38 [2]=11.70 [3]=10.81 [4]=13.64 [5]=10.94 [6]=8.96 [7]=6.16 )
# Scene 4 is split: terminal beat + planner weigh-in
S4_TERM=4.0
S4_PLAN=9.64

# Lower-third captions (empty = none)
declare -A CAP=(
  [1]="shared-brainstorm"
  [2]="1 · Ask your agent — link auto-copied"
  [3]="2 · Approve joiners — no codes, no accounts"
  [4]="3 · The team weighs in, live"
  [5]="4 · Add your answer · pick the final"
  [6]="5 · The agent plans with team input"
  [7]=""
)

# drawtext fragment for a caption (escaped). $1 = text
cap_filter() {
  local txt="$1"
  if [ -z "$txt" ]; then echo ""; return; fi
  # escape : and ' for ffmpeg
  local esc="${txt//:/\\:}"
  esc="${esc//\'/\\\'}"
  echo ",drawtext=fontfile=${FONT}:text='${esc}':fontcolor=white:fontsize=36:box=1:boxcolor=0x000000B0:boxborderw=22:x=90:y=h-130:line_spacing=8"
}

base_vf() {
  # scale+pad+fps; caption appended by caller
  echo "scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${BG}"
}

enc() { # input_args... output  (expects -vf already in input_args)
  : # placeholder
}

echo "=== building scene clips ==="

# Scenes 1,2,3,5,6,7 from single GIFs
for n in 1 2 3 5 6 7; do
  dur=${DUR[$n]}
  cap=$(cap_filter "${CAP[$n]}")
  vf="$(base_vf),tpad=stop_mode=clone:stop_duration=30,fps=${FPS}${cap},format=yuv420p"
  echo "  scene $n  (${dur}s)"
  ffmpeg -y -loglevel error -i "gifs/scene${n}.gif" -vf "$vf" -t "$dur" -an \
    -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p "clips/scene${n}.mp4"
done

# Scene 4 part A: terminal beat
cap4=$(cap_filter "${CAP[4]}")
echo "  scene 4a terminal (${S4_TERM}s)"
ffmpeg -y -loglevel error -i "gifs/scene4-term.gif" \
  -vf "$(base_vf),tpad=stop_mode=clone:stop_duration=30,fps=${FPS}${cap4},format=yuv420p" \
  -t "$S4_TERM" -an -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p "clips/scene4a.mp4"

# Scene 4 part B: planner weigh-in from PNG frames
cat > clips/s4frames.txt <<EOF
file '$(pwd)/s4frames/s4f-01.png'
duration 2.0
file '$(pwd)/s4frames/s4f-02.png'
duration 1.7
file '$(pwd)/s4frames/s4f-03.png'
duration 1.7
file '$(pwd)/s4frames/s4f-04.png'
duration 2.1
file '$(pwd)/s4frames/s4f-05.png'
duration 2.14
file '$(pwd)/s4frames/s4f-05.png'
EOF
echo "  scene 4b planner (${S4_PLAN}s)"
ffmpeg -y -loglevel error -f concat -safe 0 -i clips/s4frames.txt \
  -vf "$(base_vf),fps=${FPS}${cap4},format=yuv420p" \
  -t "$S4_PLAN" -an -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p "clips/scene4b.mp4"

# Concat 4a + 4b -> scene4
printf "file '%s/clips/scene4a.mp4'\nfile '%s/clips/scene4b.mp4'\n" "$(pwd)" "$(pwd)" > clips/s4cat.txt
ffmpeg -y -loglevel error -f concat -safe 0 -i clips/s4cat.txt -c copy "clips/scene4.mp4"

echo "=== building audio track ==="
for n in 1 2 3 4 5 6 7; do
  dur=${DUR[$n]}
  ffmpeg -y -loglevel error -i "audio/scene-0${n}.mp3" -af "apad" -t "$dur" -ar 44100 -ac 2 "aud/s${n}.wav"
done
printf "file '%s/aud/s%s.wav'\n" "$(pwd)" 1 > clips/audcat.txt
for n in 2 3 4 5 6 7; do printf "file '%s/aud/s%s.wav'\n" "$(pwd)" "$n" >> clips/audcat.txt; done
ffmpeg -y -loglevel error -f concat -safe 0 -i clips/audcat.txt -c:a aac -b:a 192k "clips/narration.m4a"

echo "=== concat video scenes ==="
printf "file '%s/clips/scene%s.mp4'\n" "$(pwd)" 1 > clips/vidcat.txt
for n in 2 3 4 5 6 7; do printf "file '%s/clips/scene%s.mp4'\n" "$(pwd)" "$n" >> clips/vidcat.txt; done
ffmpeg -y -loglevel error -f concat -safe 0 -i clips/vidcat.txt -c copy "clips/video-mute.mp4"

echo "=== mux video + narration ==="
ffmpeg -y -loglevel error -i "clips/video-mute.mp4" -i "clips/narration.m4a" \
  -c:v copy -c:a aac -b:a 192k -shortest "shared-brainstorm-promo.mp4"

echo "=== DONE ==="
ffprobe -v error -show_entries format=duration:stream=width,height,codec_type -of default=noprint_wrappers=1 "shared-brainstorm-promo.mp4"
ls -la shared-brainstorm-promo.mp4
