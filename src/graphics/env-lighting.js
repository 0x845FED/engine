import { Debug } from '../core/debug.js';
import { Vec4 } from '../math/vec4.js';
import { Texture } from './texture.js';
import { reprojectTexture } from './reproject-texture.js';
import { TEXTURETYPE_DEFAULT, TEXTURETYPE_RGBM,
    TEXTUREPROJECTION_EQUIRECT,
    ADDRESS_CLAMP_TO_EDGE,
    PIXELFORMAT_R8_G8_B8_A8, PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA32F } from './constants';

const fixCubemapSeams = true;

const supportsFloat16 = (device) => {
    return device.extTextureHalfFloat && device.textureHalfFloatRenderable;
};

const supportsFloat32 = (device) => {
    return device.extTextureFloat && device.textureFloatRenderable;
};

// lighting source should be stored HDR
const lightingSourcePixelFormat = (device) => {
    return supportsFloat16(device) ? PIXELFORMAT_RGBA16F :
        supportsFloat32(device) ? PIXELFORMAT_RGBA32F :
            PIXELFORMAT_R8_G8_B8_A8;
};

// runtime lighting can be RGBM
const lightingPixelFormat = (device) => {
    return PIXELFORMAT_R8_G8_B8_A8;
};

const createCubemap = (device, size, format, mipmaps) => {
    return new Texture(device, {
        name: `lighting-${size}`,
        cubemap: true,
        width: size,
        height: size,
        format: format,
        type: format === PIXELFORMAT_R8_G8_B8_A8 ? TEXTURETYPE_RGBM : TEXTURETYPE_DEFAULT,
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE,
        fixCubemapSeams: fixCubemapSeams,
        mipmaps: !!mipmaps
    });
};

// generate mipmaps for the given target texture
// target is either 2d equirect or cubemap with mipmaps = false
const generateMipmaps = (target) => {
    const device = target.device;

    Debug.pushGpuMarker(device, "genMipmaps");

    // create mipmapped result
    const result = new Texture(device, {
        name: target.name + '-mipmaps',
        cubemap: target.cubemap,
        width: target.width,
        height: target.height,
        format: target.format,
        type: target.type,
        addressU: target.addressU,
        addressV: target.addressV,
        fixCubemapSeams: target.fixCubemapSeams,
        mipmaps: true
    });

    // copy top level
    reprojectTexture(target, result, {
        numSamples: 1
    });

    target.destroy();

    Debug.popGpuMarker(device);

    return result;
};

// helper functions to support prefiltering lighting data
class EnvLighting {
    /**
     * @private
     * @function
     * @name generateSkyboxCubemap
     * @description Generate a skybox cubemap in the correct pixel format from the source texture.
     * @param {Texture} source - The source texture. This is either a 2d texture in equirect format or a cubemap.
     * @param {number} [size] - Size of the resulting texture. Otherwise use automatic sizing.
     * @returns {Texture} The resulting cubemap.
     */
    static generateSkyboxCubemap(source, size) {
        const device = source.device;

        Debug.pushGpuMarker(device, "genSkyboxCubemap");

        const result = createCubemap(device, size || (source.cubemap ? source.width : source.width / 4), PIXELFORMAT_R8_G8_B8_A8, false);

        reprojectTexture(source, result, {
            numSamples: 1024
        });

        Debug.popGpuMarker(device);

        return result;
    }

    /**
     * @private
     * @function
     * @name generateLightingSource
     * @description Create a texture in the format needed to precalculate lighting data.
     * @param {Texture} source - The source texture. This is either a 2d texture in equirect format or a cubemap.
     * @returns {Texture} The resulting cubemap.
     */
    static generateLightingSource(source) {
        const device = source.device;

        Debug.pushGpuMarker(device, "genLightingSource");

        const result = createCubemap(device, 128, lightingSourcePixelFormat(device), false);

        // copy into top level
        reprojectTexture(source, result, {
            numSamples: source.mipmaps ? 1 : 1024
        });

        Debug.popGpuMarker(device);

        // generate mipmaps
        return generateMipmaps(result);
    }

    /**
     * @private
     * @function
     * @name generateAtlas
     * @description Generate the environment lighting atlas containing prefiltered reflections and ambient.
     * @param {Texture} source - The source lighting texture, generated by generateLightingSource.
     * @param {object} options - Specify prefilter options.
     * @returns {Texture} The resulting atlas
     */
    static generateAtlas(source, options) {
        const device = source.device;
        const format = lightingPixelFormat(device);

        Debug.pushGpuMarker(device, "genAtlas");

        const result = options?.target || new Texture(device, {
            width: 512,
            height: 512,
            format: format,
            type: format === PIXELFORMAT_R8_G8_B8_A8 ? TEXTURETYPE_RGBM : TEXTURETYPE_DEFAULT,
            projection: TEXTUREPROJECTION_EQUIRECT,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            mipmaps: false
        });

        const rect = new Vec4(0, 0, 512, 256);

        Debug.pushGpuMarker(device, "reflection");

        // generate top-level reflection
        reprojectTexture(source, result, {
            numSamples: 1,
            rect: rect,
            seamPixels: 1
        });

        // generate blurry reflections
        for (let i = 1; i < 7; ++i) {
            rect.y += rect.w;
            rect.z = Math.max(1, Math.floor(rect.z * 0.5));
            rect.w = Math.max(1, Math.floor(rect.w * 0.5));
            reprojectTexture(source, result, {
                numSamples: options?.numSamples || 1024,
                distribution: options?.distribution || 'ggx',
                specularPower: Math.max(1, 2048 >> (i * 2)),
                rect: rect,
                seamPixels: 1
            });
        }

        Debug.popGpuMarker(device);

        rect.set(256, 256, 64, 32);

        Debug.pushGpuMarker(device, "ambient");

        // generate ambient
        if (options?.legacyAmbient) {
            reprojectTexture(source, result, {
                numSamples: options?.numSamples || 4096,
                distribution: 'phong',
                specularPower: 2,
                rect: rect,
                seamPixels: 1
            });
        } else {
            reprojectTexture(source, result, {
                numSamples: options?.numSamples || 2048,
                distribution: 'lambert',
                rect: rect,
                seamPixels: 1
            });
        }

        Debug.popGpuMarker(device);
        Debug.popGpuMarker(device);

        return result;
    }

    /**
     * @private
     * @function
     * @name packPrefiltered
     * @description Generate the environment lighting atlas from prefiltered cubemap data.
     * @param {Texture[]} sources - Array of 6 prefiltered textures.
     * @param {object} options - The options object
     * @returns {Texture} The resulting atlas
     */
    static generatePrefilteredAtlas(sources, options) {
        const device = sources[0].device;
        const format = lightingPixelFormat(device);

        Debug.pushGpuMarker(device, "genPrefilteredAtlas");

        const result = options?.target || new Texture(device, {
            width: 512,
            height: 512,
            format: format,
            type: format === PIXELFORMAT_R8_G8_B8_A8 ? TEXTURETYPE_RGBM : TEXTURETYPE_DEFAULT,
            projection: TEXTUREPROJECTION_EQUIRECT,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            mipmaps: false
        });

        const rect = new Vec4(0, 0, 512, 256);

        Debug.pushGpuMarker(device, "reflection");

        // copy blurry reflections
        for (let i = 0; i < sources.length; ++i) {
            reprojectTexture(sources[i], result, {
                numSamples: 1,
                rect: rect,
                seamPixels: 1
            });
            rect.y += rect.w;
            rect.z = Math.max(1, Math.floor(rect.z * 0.5));
            rect.w = Math.max(1, Math.floor(rect.w * 0.5));
        }

        Debug.popGpuMarker(device);

        rect.set(256, 256, 64, 32);

        Debug.pushGpuMarker(device, "ambient");

        // generate ambient
        if (options?.legacyAmbient) {
            reprojectTexture(sources[5], result, {
                numSamples: 1,
                rect: rect,
                seamPixels: 1
            });
        } else {
            reprojectTexture(sources[0], result, {
                numSamples: options?.numSamples || 2048,
                distribution: 'lambert',
                rect: rect,
                seamPixels: 1
            });
        }

        Debug.popGpuMarker(device);
        Debug.popGpuMarker(device);

        return result;
    }
}

export {
    EnvLighting
};