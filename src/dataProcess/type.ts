/*
 * @Author: chenguofeng chenguofeng@bytedance.com
 * @Date: 2024-07-20 01:48:36
 * @LastEditors: chenguofeng chenguofeng@bytedance.com
 * @LastEditTime: 2024-07-20 21:18:35
 * @FilePath: \photo2reliefNegativeFilm\src\dataProcess\type.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */

export interface Config {
  BaseDeep: number;
  LayerDeep: number;
  MaxLength: number;
  MaxDeep: number;
  Quality: number;
  AddBorder: boolean;
  BorderWidth: number;
  BorderHeight: number;
}

export type RGBMap = Array<RGBLines>;
export type RGBLines = Array<RGBPixel>;
export type RGBPixel = [r: number, g: number, b: number];

export type CMYKPixel = [c: number, m: number, y: number, k: number];

export type DeepMap = Array<DeepLines>;
export type DeepLines = Array<number>;
export type CmkydeepMap = {
  c: DeepMap;
  m: DeepMap;
  y: DeepMap;
  k: DeepMap;
};
