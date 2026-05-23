#!/usr/bin/env bash
# Generate per-scene narration via ElevenLabs. Throwaway build helper.
set -euo pipefail
# Voice + delivery overridable via env so we can build alternate narration sets.
VOICE="${VOICE:-JBFqnCBsd6RMkjVDRZzb}"   # default: George — calm male narrative
MODEL="eleven_multilingual_v2"
OUT="${OUT_DIR:-$(dirname "$0")/audio}"
STABILITY="${STABILITY:-0.5}"
SIMILARITY="${SIMILARITY:-0.75}"
STYLE="${STYLE:-0.0}"
mkdir -p "$OUT"

declare -a SCENES=(
"Your AI agent plans alone. But the real product decisions — they need your team. shared-brainstorm pulls your teammates into the planning loop."
"Just ask. Your agent spins up a session and hands you a share link — already copied to your clipboard. Nothing to install, no sign-up. You drive the whole thing right here in the terminal."
"Teammates open the link in any browser. You're the gate — approve each one from the coordinator tab. No join codes, no accounts. They're in, in seconds."
"Your agent posts the question — one at a time, or a whole batch. Teammates weigh in live: suggestions, comments, even questions back to the AI. Everyone sees everything update in real time."
"Add your own take to the pool — your teammates see it as the coordinator's. Then pick the final answer from every candidate, yours included. One click records the decision."
"The answer flows straight back to your agent, which plans with your team's real input. Every decision is saved to a transcript on disk."
"shared-brainstorm. Your team, in your agent's planning loop. One command to start."
)

i=1
for text in "${SCENES[@]}"; do
  n=$(printf "%02d" "$i")
  body=$(jq -n --arg t "$text" --arg m "$MODEL" \
    --argjson stab "$STABILITY" --argjson sim "$SIMILARITY" --argjson sty "$STYLE" \
    '{text:$t, model_id:$m, voice_settings:{stability:$stab, similarity_boost:$sim, style:$sty, use_speaker_boost:true}}')
  echo "→ scene $n: ${text:0:48}..."
  http=$(curl -s -w '%{http_code}' -o "$OUT/scene-$n.mp3" \
    -X POST "https://api.elevenlabs.io/v1/text-to-speech/$VOICE" \
    -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" \
    -d "$body")
  if [ "$http" != "200" ]; then
    echo "  !! HTTP $http"; cat "$OUT/scene-$n.mp3"; echo; exit 1
  fi
  i=$((i+1))
done
echo "DONE"
ls -la "$OUT"
