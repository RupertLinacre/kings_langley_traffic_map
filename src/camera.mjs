// World coordinates are metres; the renderer draws them around the viewport centre.
export class MapCamera {
    constructor(bounds) {
        this.bounds = bounds;
        this.view = { x: 0, y: 0, scale: 1.6 };
        this.width = this.height = 1;
        this.area = { left: 0, top: 0, width: 1, height: 1 };
    }
    get fitScale() {
        const b = this.bounds;
        return Math.min(0.8, this.area.width / (b.right - b.left + 180), this.area.height / (b.bottom - b.top + 180));
    }
    get centre() {
        return [this.area.left + this.area.width / 2, this.area.top + this.area.height / 2];
    }
    scaleAt(value) {
        return value < 100 ? this.fitScale * (1.6 / this.fitScale) ** ((value - 50) / 50) : 1.6 * 2 ** ((value - 100) / 50);
    }
    get zoomValue() {
        const scale = this.view.scale;
        return scale < 1.6 ? 50 + 50 * Math.log(scale / this.fitScale) / Math.log(1.6 / this.fitScale) : 100 + 50 * Math.log2(scale / 1.6);
    }
    worldAt(x, y) {
        return [this.view.x + (x - this.width / 2) / this.view.scale, this.view.y + (y - this.height / 2) / this.view.scale];
    }
    anchor(point, x, y) {
        this.view.x = point[0] - (x - this.width / 2) / this.view.scale;
        this.view.y = point[1] - (y - this.height / 2) / this.view.scale;
    }
    resize(width, height, area) {
        const point = this.worldAt(...this.centre), whole = this.zoomValue <= 50.01;
        this.width = width; this.height = height; this.area = area;
        if (whole) this.fit();
        else {
            this.view.scale = Math.max(this.fitScale, this.view.scale);
            this.anchor(point, ...this.centre);
        }
    }
    zoomAt(scale, x = this.centre[0], y = this.centre[1]) {
        const point = this.worldAt(x, y);
        this.view.scale = Math.max(this.fitScale, Math.min(this.scaleAt(160), scale));
        this.anchor(point, x, y);
    }
    pan(dx, dy) {
        this.view.x -= dx / this.view.scale;
        this.view.y -= dy / this.view.scale;
    }
    focus(point, zoom = 100) {
        this.view.scale = this.scaleAt(zoom);
        this.anchor(point, ...this.centre);
    }
    frame(bounds, padding = 48) {
        const scale = Math.min(
            Math.max(80, this.area.width - padding * 2) / Math.max(1, bounds.right - bounds.left),
            Math.max(80, this.area.height - padding * 2) / Math.max(1, bounds.bottom - bounds.top),
        );
        this.view.scale = Math.max(this.fitScale, Math.min(this.scaleAt(160), scale));
        this.anchor([(bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2], ...this.centre);
    }
    fit() {
        const b = this.bounds;
        this.focus([(b.left + b.right) / 2, (b.top + b.bottom) / 2], 50);
    }
}
