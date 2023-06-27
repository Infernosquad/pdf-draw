import L, {PathOptions} from "leaflet";
import "@geoman-io/leaflet-geoman-free";

import "./patches/fix-leaflet-marker";

import PDFExporter, { GeomanLayer } from "./PDFExporter";
import PDFRenderer from "./PDFRenderer";
import { canvasOverlay, CanvasOverlay } from "./plugins/CanvasOverlay";
import { cloudPolygon } from "./plugins/CloudPolyline";
import Measurements from "./plugins/Measure";
import { CalibrateCallback } from "./plugins/Measure/Calibrate";
import PixelCRS from "./plugins/PixelCRS";
import { ColorClickCallback, colorPicker } from "./plugins/ColorPicker";

import "./PDFGo.css";
import { save } from "./plugins/Save";
import {cloudPolylineRenderer} from "./plugins/CloudPolyline/CloudPolylineRenderer";

type SaveClickCallback = (bytes?: Uint8Array) => Promise<void>;

type SaveSettings = {
  // Callback for when the button is clicked.
  // If download is false, the PDF bytes are passed.
  onClick?: SaveClickCallback;

  // Whether the button should trigger a download
  // Default: false
  download?: boolean;
};

type PDFGoProps = {
  // Div element to render the viewer to
  element: HTMLDivElement;

  // Which page to render (starting at 1)
  // Default: 1
  pageNumber?: number;

  // Min zoom level
  // Default: -2
  minZoom?: number;

  // Max zoom level
  // Default: 2
  maxZoom?: number;

  // Initial zoom level
  // Default: -2
  zoom?: number;

  // The function that is called when the user performs a calibration.
  //
  // Will be called with the length in the PDF and a reference to the
  // calibration button to which a popup can be attached.
  onCalibrate?: CalibrateCallback;

  // Called when clicking the color picker button.
  //
  // The element passed is the color button itself, which can be used to
  // attach any color picker near the color button.
  onColorClick?: ColorClickCallback;

  // If supplied, a save button will be added to the toolbar
  // with the given settings.
  saveSettings?: SaveSettings;
};

interface JSONLayer {
  type?: string,
  latLngs: any,
  options: PathOptions | any
}

export default class PDFGo {
  private map: L.Map;

  private pageNumber: number;

  private pdfRenderer?: PDFRenderer;

  private overlay?: CanvasOverlay;

  private measurements?: Measurements;

  private onCalibrate?: CalibrateCallback;

  private onColorClick?: ColorClickCallback;

  private saveSettings?: SaveSettings;

  // Width of canvas in map
  private canvasWidth: number = 0;

  // File (PDF) to render
  private file?: Uint8Array;

  // File name to save the PDF with
  private fileName?: string;

  // Color picker color
  private color: string = "#3388ff";

  constructor({
    element,
    pageNumber = 1,
    minZoom = -2,
    maxZoom = 2,
    zoom = -2,
    onCalibrate,
    onColorClick,
    saveSettings,
  }: PDFGoProps) {
    this.map = L.map(element, {
      zoom,
      minZoom,
      maxZoom,
      center: [0, 0],
      crs: PixelCRS,
      attributionControl: false,
    });
    this.pageNumber = pageNumber;
    this.onCalibrate = onCalibrate;
    this.measurements = new Measurements(this.map, this.onCalibrate);
    this.onColorClick = onColorClick;
    this.saveSettings = saveSettings;
    this.initializeHandlers();
    this.initializeToolbar();
  }

  getColor(): string {
    return this.color;
  }

  // Set rgb color (hex format)
  setColor(color: string) {
    this.color = color;
    document
      .querySelectorAll(".leaflet-color-picker-button")
      .forEach((element) => {
        const button = element as HTMLDivElement;
        button.style.backgroundColor = color;
      });

    this.map.pm.setPathOptions(
      { color },
      { merge: true, ignoreShapes: ["Ruler", "Calibrate", "Area"] }
    );
  }

  importFromJSON(json: string): void {
    JSON.parse(json).forEach((feature: JSONLayer) => {
      switch (feature.options.renderer) {
        case 'CloudPolylineRenderer':
          feature.options.renderer = cloudPolylineRenderer(feature.options)
      }

        switch (feature.type) {
          case "Circle":
            new L.Circle(feature.latLngs, feature.options).addTo(this.map);
            break;
          case "Polyline":
            new L.Polyline(feature.latLngs, feature.options).addTo(this.map);
            break;
          case "Marker":
            new L.Marker(feature.latLngs, feature.options).addTo(this.map);
            break;
          case "Polygon":
            new L.Polygon(feature.latLngs, feature.options).addTo(this.map);
            break;
          // case "Circlemarker":
          //   new L.CircleMarker(feature.latLngs, feature.options).addTo(this.map);
          //   break;
        }
      })
  }

  getGeoJSON(): string {

    const json: any = []

    this.map.eachLayer(layer => {
      if (layer instanceof L.Circle) {
        const jsonLayer: JSONLayer = {
          type: "Circle",
          options: layer.options,
          latLngs: layer.getBounds().getCenter()
        }
        json.push(jsonLayer);
      }

      if (layer instanceof L.Polyline) {
        const options: any = layer.options;
        if (layer.options.renderer !== undefined) {
          options.renderer = 'CloudPolylineRenderer'
        }
        const jsonLayer: JSONLayer = {
          type: "Polyline",
          options: options,
          latLngs: layer.getLatLngs()
        }
        json.push(jsonLayer);
      }

      if (layer instanceof L.Marker) {
        const jsonLayer: JSONLayer = {
          type: "Marker",
          options: layer.options,
          latLngs: layer.getLatLng()
        }
        json.push(jsonLayer);
      }

      if (layer instanceof L.CircleMarker) {
        const jsonLayer: JSONLayer = {
          type: "Circlemarker",
          options: layer.options,
          latLngs: layer.getLatLng()
        }
        json.push(jsonLayer);
      }

      if (layer instanceof L.Polygon) {
        const options: any = layer.options;
        if (layer.options.renderer !== undefined) {
          options.renderer = 'CloudPolylineRenderer'
        }
        const jsonLayer: JSONLayer = {
          type: "Polygon",
          options: options,
          latLngs: layer.getLatLngs()
        }
        json.push(jsonLayer);
      }
    })

    return JSON.stringify(json)
  }

  // Load the file in the typed array. `name` is the name that
  // the pdf should be saved with later.
  async loadFile(file: Uint8Array, name: string) {
    this.clearMap();
    this.file = file;
    this.fileName = name;

    // Initialize the canvas PDF renderer
    this.pdfRenderer = new PDFRenderer({
      file,
      pageNumber: this.pageNumber,
      minZoom: this.map.getMinZoom(),
    });

    // Render and draw the PDF to the leaflet map
    const canvas = await this.pdfRenderer.renderPage(this.map.getZoom());
    const bounds: L.LatLngBoundsExpression = [
      [0, 0],
      [canvas.height, canvas.width],
    ];
    this.overlay = canvasOverlay(canvas, L.latLngBounds(bounds)).addTo(
      this.map
    );
    this.map.setView([canvas.height / 2, canvas.width / 2]);
    this.canvasWidth = canvas.width;

    // Initialize the measurement tools
    const { width, height } = await this.pdfRenderer.getBoundaries();
    this.measurements?.updateDimensions(width, height, canvas.width);

    // Create save button
    if (this.saveSettings) {
      const shouldDownload = this.saveSettings.download ?? false;
      const saveCb = async () => {
        let bytes;
        if (shouldDownload) {
          await this.downloadPdf();
        } else {
          bytes = await this.savePdf();
        }

        this.saveSettings?.onClick?.(bytes);
      };

      save(this.map, saveCb);
    }

    // Re-set color (the button is redrawn so we need to re-set the style)
    this.setColor(this.color);
  }

  // Download the pdf with all annotations.
  async downloadPdf() {
    if (!this.file || !this.fileName) {
      throw new Error("Cannot download PDF before PDF has been loaded");
    }

    const exporter = await PDFExporter.init({
      file: this.file,
      name: this.fileName,
      canvasWidth: this.canvasWidth,
    });

    const layers = this.map.pm.getGeomanLayers() as GeomanLayer[];
    await exporter.drawLayers(layers, this.pageNumber - 1);
    await exporter.downloadPdf();
  }

  // Return the new PDF with all annotations as a typed array.
  async savePdf(): Promise<Uint8Array> {
    if (!this.file || !this.fileName) {
      throw new Error("Cannot download PDF before PDF has been loaded");
    }

    const exporter = await PDFExporter.init({
      file: this.file,
      name: this.fileName,
      canvasWidth: this.canvasWidth,
    });

    const layers = this.map.pm.getGeomanLayers() as GeomanLayer[];
    await exporter.drawLayers(layers, this.pageNumber - 1);
    return exporter.savePdf();
  }

  // Adjust the scale of the loaded PDF.
  //
  // `length` is the value passed to `onCalibrate` (a length in points)
  // and `actualLength` should be a string suffixed with ft or m without
  // any spaces. E:g., 23ft or 8m.
  adjustScale(length: number, actualLength: string) {
    this.measurements?.adjustScale(length, actualLength);
  }

  // Destroy the PDF viewer
  destroy() {
    this.map.remove();
  }

  private clearMap() {
    this.map.eachLayer((layer) => this.map.removeLayer(layer));
  }

  private initializeHandlers() {
    this.map.on("zoomend", this.onZoom, this);
  }

  private initializeToolbar() {
    this.map.pm.addControls({
      position: "topleft",
      drawCircleMarker: false,
      cutPolygon: false,

      // Ruler, Calibrate and Area are all placed in the "custom" block
      // and hidden so we can trigger them from the Measurements actions
      // without showing another button in the toolbar
      customControls: false,
    });

    this.map.pm.setGlobalOptions({
      allowSelfIntersection: false,
      continueDrawing: false,
    });

    // Cloud polyline button
    cloudPolygon(this.map);

    // Color picker
    colorPicker({
      map: this.map,
      color: this.color,
      onClick: this.onColorClick,
      onColorSelect: this.setColor,
    });
  }

  private async onZoom() {
    // Cannot handle zoom before PDF has been loaded
    if (!this.overlay || !this.pdfRenderer) {
      return;
    }

    const canvas = await this.pdfRenderer.renderPage(this.map.getZoom());
    this.overlay.setCanvas(canvas);
  }
}
