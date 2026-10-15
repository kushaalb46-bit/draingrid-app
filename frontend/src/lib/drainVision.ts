import { pipeline } from '@huggingface/transformers';

const CONDITIONS = [
  { label: 'a clear storm drain with no visible blockage', intensity: 10 },
  { label: 'a storm drain with a small amount of leaves and litter', intensity: 30 },
  { label: 'a storm drain partially blocked by debris, rubbish and silt', intensity: 55 },
  { label: 'a severely blocked storm drain with garbage and standing water', intensity: 80 },
  { label: 'a completely blocked overflowing storm drain causing flooding', intensity: 95 },
] as const;

type Prediction = { label: string; score: number };

let modelPromise: Promise<any> | undefined;

export async function analyseDrainPhoto(file: File) {
  modelPromise ??= pipeline(
    'zero-shot-image-classification',
    'Xenova/clip-vit-base-patch32',
  ).catch((error) => {
    modelPromise = undefined;
    throw error;
  });

  const model = await modelPromise;
  const imageUrl = URL.createObjectURL(file);

  try {
    const predictions = (await model(
      imageUrl,
      CONDITIONS.map((condition) => condition.label),
    )) as Prediction[];

    if (!predictions.length) {
      throw new Error('The vision model returned no predictions.');
    }

    const best = predictions[0];
    const condition = CONDITIONS.find((item) => item.label === best.label);

    if (!condition) {
      throw new Error('Could not classify the drain photo.');
    }

    return {
      label: condition.label,
      intensity: condition.intensity,
      method: 'browser-clip-zero-shot',
    };
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}
