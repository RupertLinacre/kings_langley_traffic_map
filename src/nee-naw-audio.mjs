// Generated locally: no recording, download or audio autoplay before a gesture.
export function createNeeNawAudio({ AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext } = {}) {
    let context, oscillator, gain;
    function unlock() {
        if (!AudioContext) return false;
        try {
            if (!context || context.state === 'closed') {
                context = new AudioContext();
                oscillator = context.createOscillator(); gain = context.createGain();
                oscillator.type = 'triangle'; gain.gain.value = 0;
                oscillator.connect(gain); gain.connect(context.destination); oscillator.start();
            }
            context.resume()?.catch?.(() => {});
            return true;
        } catch { return false; }
    }
    function update({ active = false, enabled = false, time = 0 } = {}) {
        if (!context || context.state === 'closed') return;
        gain.gain.setTargetAtTime(active && enabled ? 0.045 : 0, context.currentTime, 0.035);
        oscillator.frequency.setTargetAtTime(Math.floor(time / 0.48) % 2 ? 520 : 720, context.currentTime, 0.025);
    }
    function close() {
        if (!context || context.state === 'closed') return;
        update(); oscillator.stop(); context.close()?.catch?.(() => {});
        context = oscillator = gain = null;
    }
    return { supported: Boolean(AudioContext), unlock, update, close };
}
