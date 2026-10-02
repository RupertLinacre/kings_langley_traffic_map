// Export the current canvas without the controls; retain the map attribution.
export async function savePostcard(canvas, description = 'Real streets. Imagined journeys.') {
    const ratio = canvas.width / innerWidth, footer = Math.round(96 * ratio);
    const postcard = document.createElement('canvas');
    postcard.width = canvas.width; postcard.height = canvas.height + footer;
    const g = postcard.getContext('2d');
    g.drawImage(canvas, 0, 0);
    g.fillStyle = '#fffdf6'; g.fillRect(0, canvas.height, postcard.width, footer);
    g.translate(0, canvas.height); g.scale(ratio, ratio);
    g.fillStyle = '#324536'; g.font = '26px Georgia, serif';
    g.fillText('Kings Langley', 24, 36);
    g.fillStyle = '#65745b'; g.font = '11px system-ui, sans-serif';
    g.fillText(description, 24, 57, innerWidth - 48);
    g.font = '9px system-ui, sans-serif';
    g.fillText('Map data © OpenStreetMap contributors · openstreetmap.org/copyright', 24, 78, innerWidth - 48);
    const blob = await new Promise(resolve => postcard.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not create the postcard.');
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'kings-langley-postcard.png';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
