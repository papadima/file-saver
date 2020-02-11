import path from 'path'
import fs from 'fs'
import { IncomingMessage } from 'http'
import uuidv4 from 'uuid/v4'
import wget from 'wget-improved'
import jo from 'jpeg-autorotate'
import sharp from 'sharp'
import textToPicture from 'text-to-picture'
import { IncomingForm } from 'formidable'
import { RichError } from '@noname.team/errors'
import { error_codes as errorCodes } from './const.json'

/**
 * Download a file by URL
 * @param {Object} params
 * @param {!String} params.url - is source URL
 * @param {!String} params.to - is target path
 * @param {?Function} [params.onStart] - helper method that is firing on start of downloading
 * @param {?Function} [params.onProgress] - helper method that is firing multiple times while downloading
 * @param {?Object} [params.wgetOptions] - wget-improved options
 * @return {Promise<Object, RichError>} - resolves when everything is ok. Reject errors if image source is broken or if image can't be loaded
 */
const download = ({
  url,
  to,
  onStart = fileSize => fileSize,
  onProgress = progress => progress,
  wgetOptions = {}
}) => new Promise((resolve, reject) => {
  let urlParsed

  try {
    urlParsed = new URL(url)
  } catch (error) {
    return reject(new RichError(error.message || 'Image source is broken', errorCodes.ERR_IMAGE_SOURCE_BROKEN))
  }

  wget.download(urlParsed.href, to, wgetOptions)
    .on('error', (error) => reject(new RichError(error.message || 'Image can not be loaded', errorCodes.ERR_IMAGE_CAN_NOT_BE_LOADED)))
    .on('start', onStart)
    .on('progress', onProgress)
    .on('end', resolve)
})

/**
 * Validate a file as exactly image file
 * @param {!String} imagePath - is image path
 * @return {Promise<Object, RichError>} - resolves when everything is ok. Reject error if image source is broken
 */
const validateImageFile = async (imagePath) => {
  let buffer

  try {
    buffer = await sharp(imagePath).toBuffer()
    return fs.writeFileSync(imagePath, buffer)
  } catch (error) {
    throw new RichError('Image source is broken', errorCodes.ERR_IMAGE_SOURCE_BROKEN)
  }
}

/**
 * ImageSaver class. Use it for image downloading, processing and storing wherever you want.
 */
export default class ImageSaver {
  /**
   * @param {Object} config - input configuration.
   * @param {!String} config.targetDir - is output system directory.
   * @param {?Array<String>} [config.validExtensions=['jpg', 'png']] - acceptable image extensions.
   * @return {Object} - an instance.
   */
  constructor ({ targetDir, validExtensions = ['jpg', 'png'] } = {}) {
    /**
     * @type {Object}
     * @property {String} target.dir
     * @property {String} target.path
     * @property {String} target.fileName
     */
    this.target = {
      dir: targetDir,
      path: null,
      fileName: null
    }
    /** @property {boolean} */
    this.validExtensions = validExtensions

    this.download = this.download.bind(this)
    this.process = this.process.bind(this)
  }

  /**
   * This method is a firstable step of image saving.
   * @param {!(String|Object)} source - image source. String means that this is URL or you can provide an Object that is for Http Request instance
   * @param {?String} [targetName=uuidv4()] - is output file name w/o extension.
   * @return {Promise<Object, Error>} - return a current instance.
   * @todo support multiple files by a single call
   */
  async download (source, targetName = uuidv4()) {
    if (typeof source === 'string') {
      let urlParsed

      try {
        urlParsed = new URL(source)
      } catch (error) {
        throw new RichError(error.message || 'Image source is broken', errorCodes.ERR_IMAGE_SOURCE_BROKEN)
      }

      const sourceFileName = urlParsed.pathname.split('/')
        .pop()
      const extension = sourceFileName.split('.')
        .pop()

      if (!this.validExtensions.includes(extension)) {
        throw new RichError('Unsupported image format', errorCodes.ERR_IMAGE_FORMAT_UNSUPPORTED)
      }

      this.target.fileName = `${targetName}.${extension}`
      this.target.path = path.join(this.target.dir, this.target.fileName)

      try {
        await download({ url: source, to: this.target.path })
        await validateImageFile(this.target.path)
      } catch (error) {
        try {
          fs.unlinkSync(this.target.path)
        } catch (errorUnlink) {
        }
        throw error
      }
    } else if (source instanceof IncomingMessage) {
      await new Promise((resolve, reject) => {
        const form = new IncomingForm({ uploadDir: this.target.dir, keepExtensions: true })

        form.on('file', async (_, file) => {
          let joResult
          const extension = file.name.split('.')
            .pop()

          if (!this.validExtensions.includes(extension)) {
            try {
              fs.unlinkSync(file.path)
            } catch (errorUnlink) {
            }
            return reject(new RichError('Unsupported image format', errorCodes.ERR_IMAGE_FORMAT_UNSUPPORTED))
          }

          this.target.fileName = `${targetName}.${extension}`
          this.target.path = path.join(this.target.dir, this.target.fileName)

          try {
            joResult = await jo.rotate(file.path, { quality: 100 })
            fs.writeFileSync(this.target.path, joResult.buffer)
          } catch (error) {
            fs.renameSync(file.path, this.target.path)
          }
          try {
            await validateImageFile(this.target.path)
          } catch (error) {
            reject(error)
          }
          return resolve()
        })
        form.parse(source, (error, fields, files) => {
          if (error || !Object.keys(files).length) {
            reject(new RichError('Image source is broken', errorCodes.ERR_IMAGE_SOURCE_BROKEN))
          }
        })
      })
    } else {
      throw new RichError('Image source is broken', errorCodes.ERR_IMAGE_SOURCE_BROKEN)
    }

    return this
  }

  /**
   * This method is optional step for image processing.
   * @param {Object} config
   * @param {Object} config.transformer - sharp operations.
   * @param {?Array<Object>} config.textOverlays - objects of text-to-picture pkg
   * @return {Promise<Object, Error>} - return a current instance. Throw errors when file system troubles.
   */
  async process ({ transformer, textOverlays }) {
    const readStream = fs.createReadStream(this.target.path)
    const image = await readStream.pipe(transformer)
    const buffer = await image.toBuffer()

    fs.writeFileSync(this.target.path, buffer)

    const metadata = await sharp(this.target.path).metadata()
    const [name, originalExtension] = this.target.fileName.split('.')
    const originalFormat = originalExtension === 'jpg' ? 'jpeg' : originalExtension

    if (originalFormat !== metadata.format) {
      const oldPath = this.target.path
      const extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format

      this.target.fileName = `${name}.${extension}`
      this.target.path = path.join(this.target.dir, this.target.fileName)
      fs.renameSync(oldPath, this.target.path)
    }

    if (Array.isArray(textOverlays)) {
      const overlaysBuffers = await Promise.all(textOverlays.map(async (t) => {
        const result = await textToPicture.convert(t)

        return result.getBuffer()
      }))
      const bufferWithOverlays = await sharp(this.target.path)
        .composite(overlaysBuffers.map((input) => ({ input })))
        .toBuffer()

      fs.writeFileSync(this.target.path, bufferWithOverlays)
    }

    return this
  }
}
