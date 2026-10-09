// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createPoiSpriteSizeTuner, createCompassScaleTuner, type VisualizationTunerSettings } from "../src/hud/visualizationTuners.js";
import { DEFAULT_POI_SPRITE_SIZE_PARAMS, DEFAULT_ORBIT_COMPASS_SCALE_PARAMS } from "../src/index.js";

describe("injected visualization tuners",()=>{
  it.each([
    ["poiSprite",createPoiSpriteSizeTuner,DEFAULT_POI_SPRITE_SIZE_PARAMS,"maxSize","41000"],
    ["compass",createCompassScaleTuner,DEFAULT_ORBIT_COMPASS_SCALE_PARAMS,"radiusScale","0.05"],
  ] as const)("%s uses its supplied document/registry, refuses failed saving and disposes callbacks",(_name,create,defaults,key,value)=>{
    const doc=document.implementation.createHTMLDocument("host"),container=doc.createElement("div");doc.body.append(container);
    let allowed=false;const values=Object.fromEntries(Object.entries(defaults).map(([key,value])=>[`visualization.${_name}.${key}`,value]));
    const settings:VisualizationTunerSettings={get:id=>values[id],inspect:()=>({provenance:"default"}),setMany:vi.fn(()=>({ok:allowed}))};
    const apply=vi.fn(),tuner=create(container,apply,{document:doc,settings});expect(apply).not.toHaveBeenCalled();expect(document.querySelector(".poi-sprite-tuner")).toBeNull();
    const panel=container.firstElementChild as HTMLElement;tuner.show();expect(panel.hidden).toBe(false);tuner.hide();expect(panel.hidden).toBe(true);
    const input=container.querySelector<HTMLInputElement>(`input[data-field="${key}"]`)!;input.value=value;input.dispatchEvent(new Event("input"));
    const button=container.querySelector<HTMLButtonElement>(".poi-sprite-tuner-apply")!,save=container.querySelector<HTMLButtonElement>(".poi-sprite-tuner-save-defaults")!;
    expect(button.hidden).toBe(false);button.click();expect(apply).toHaveBeenCalledTimes(1);expect(save.hidden).toBe(false);
    save.click();expect(save.hidden).toBe(false);allowed=true;save.click();expect(save.hidden).toBe(true);
    tuner.destroy();tuner.destroy();input.value="999";input.dispatchEvent(new Event("input"));button.click();expect(apply).toHaveBeenCalledTimes(1);expect(container.children).toHaveLength(0);
  });
});
