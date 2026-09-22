let loadPromise = null;

async function loadOpenCv() {
  if (!globalThis.cv) {
    if (!loadPromise) {
      loadPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "/vendor/opencv/opencv.js";
        script.async = true;
        script.onload = resolve;
        script.onerror = () =>
          reject(new Error("failed to load vendored OpenCV.js"));
        document.head.appendChild(script);
      });
    }
    await loadPromise;
  }

  const module = globalThis.cv;
  if (!module) {
    throw new Error("vendored OpenCV.js loaded without defining cv");
  }

  if (typeof module.then === "function") {
    return await module;
  }

  if (module.Mat) {
    return module;
  }

  return await new Promise((resolve) => {
    const previous = module.onRuntimeInitialized;

    module.onRuntimeInitialized = () => {
      if (typeof previous === "function") previous();
      resolve(module);
    };

    queueMicrotask(() => {
      if (module.Mat) resolve(module);
    });
  });
}

const cv = await loadOpenCv();
export default cv;
