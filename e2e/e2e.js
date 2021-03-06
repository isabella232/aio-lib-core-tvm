/*
Copyright 2019 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

const TvmClient = require('../')

jest.setTimeout(60000)

// config - THOSE ARE THE REQUIRED VARS
const testNamespace = process.env.TEST_NAMESPACE_1
const testAuth = process.env.TEST_AUTH_1
const apiUrl = process.env.TVM_API_URL.endsWith('/') ? process.env.TVM_API_URL : process.env.TVM_API_URL + '/'

const testNamespaceHash = require('crypto').createHash('sha256').update(testNamespace, 'binary').digest('hex').slice(0, 32)

const expectedAwsS3Response = {
  params: { Bucket: expect.any(String) },
  accessKeyId: expect.any(String),
  secretAccessKey: expect.any(String),
  sessionToken: expect.any(String),
  expiration: expect.any(String)
}

const expectedAzureBlobResponse = {
  sasURLPrivate: expect.any(String),
  sasURLPublic: expect.any(String),
  expiration: expect.any(String)
}

const expectedAzureCosmosResponse = {
  endpoint: expect.any(String),
  resourceToken: expect.any(String),
  databaseId: expect.any(String),
  containerId: expect.any(String),
  partitionKey: expect.any(String),
  expiration: expect.any(String)
}

const functions = ['getAwsS3Credentials', 'getAzureBlobCredentials', 'getAzureCosmosCredentials']

const expectBadStatus = async (promise, status) => {
  try {
    const res = await promise
    throw res
  } catch (e) {
    if (e.name !== 'TvmLibError') throw e
    expect(e.sdkDetails.status).toEqual(status)
  }
}

const expectBadArgument = async (promise) => {
  try {
    const res = await promise
    throw res
  } catch (e) {
    if (e.name !== 'TvmLibError') throw e
    expect(e.code).toEqual('ERROR_BAD_ARGUMENT')
  }
}

// only one ns needed for now
const initFromEnv = async (n = 1) => {
  process.env.__OW_NAMESPACE = process.env[`TEST_NAMESPACE_${n}`]
  process.env.__OW_API_KEY = process.env[`TEST_AUTH_${n}`]

  return TvmClient.init({ apiUrl, cacheFile: false }) // let's not test the cache for now
}

beforeEach(() => {
  expect.hasAssertions()
})

afterEach(() => {
  delete process.env.__OW_NAMESPACE
  delete process.env.__OW_API_KEY
})

// todo those are very similar to functional tests on tvm, try to modularize somehow
// move those to tvm?
describe('test e2e workflows', () => {
  test('aws s3 e2e test: get tvm credentials, list s3 blobs in namespace (success), list s3 blobs in other namespace (fail), list s3 buckets (fail)', async () => {
    const tvm = await initFromEnv()
    const tvmResponse = await tvm.getAwsS3Credentials()
    expect(tvmResponse).toEqual(expectedAwsS3Response)

    const aws = require('aws-sdk')
    const s3 = new aws.S3(tvmResponse)

    // todo more checks on policy operations (e.g. read, write, acl, ..)

    // success listing own resources
    const res = await s3.listObjectsV2({ Prefix: testNamespace + '/' }).promise()
    expect(res.$response.httpResponse.statusCode).toEqual(200)

    // fail listing other folder
    // todo restore this, because of CF integration, list & get within bucket is public operation now
    let err
    // try {
    //   await s3.listObjectsV2({ Prefix: 'otherNsFolder' + '/' }).promise()
    // } catch (e) {
    //   err = e
    //   // keep message for more info
    //   expect({ code: e.code, message: e.message }).toEqual({ code: 'AccessDenied', message: e.message })
    // }
    // expect(err).toBeInstanceOf(Error)

    // fail listing buckets
    err = undefined
    try {
      await s3.listBuckets().promise()
    } catch (e) {
      err = e
      // keep message for more info
      expect({ code: e.code, message: e.message }).toEqual({ code: 'AccessDenied', message: e.message })
    }
    expect(err).toBeInstanceOf(Error)
  })

  test('azure blob e2e test: get tvm credentials, list azure blobs public and private container (success)', async () => {
    const tvm = await initFromEnv()
    const tvmResponse = await tvm.getAzureBlobCredentials()
    expect(tvmResponse).toEqual(expectedAzureBlobResponse)

    // check that container names in sasURLs contain sha256 of namespace (especially important for public container)
    expect(tvmResponse.sasURLPrivate).toEqual(expect.stringContaining(testNamespaceHash))
    expect(tvmResponse.sasURLPublic).toEqual(expect.stringContaining(testNamespaceHash))

    const azure = require('@azure/storage-blob')
    const azureCreds = new azure.AnonymousCredential()
    const pipeline = azure.StorageURL.newPipeline(azureCreds)
    const containerURLPrivate = new azure.ContainerURL(tvmResponse.sasURLPrivate, pipeline)
    const containerURLPublic = new azure.ContainerURL(tvmResponse.sasURLPublic, pipeline)

    const listContainerOk = async (containerURL) => {
      const response = await containerURL.listBlobFlatSegment(azure.Aborter.none)
      expect(response._response.status).toEqual(200)
    }

    await listContainerOk(containerURLPrivate)
    await listContainerOk(containerURLPublic)
  })

  test('azure cosmos e2e test: get tvm credentials, add item + delete (success), add item in other partitionKey (fail), add item in other container (fail), add item in other db (fail)', async () => {
    const tvm = await initFromEnv()
    const tvmResponse = await tvm.getAzureCosmosCredentials()
    expect(tvmResponse).toEqual(expectedAzureCosmosResponse)

    const cosmos = require('@azure/cosmos')
    const client = new cosmos.CosmosClient({ endpoint: tvmResponse.endpoint, tokenProvider: async () => tvmResponse.resourceToken })

    const database = client.database(tvmResponse.databaseId)
    const container = database.container(tvmResponse.containerId)
    const key = 'test-key'
    const value = { some: 'value' }

    // 1. OK
    const item = (await container.items.upsert({ id: key, partitionKey: tvmResponse.partitionKey, value }))
    expect(item.statusCode).toBeLessThan(300)
    expect(item.statusCode).toBeGreaterThanOrEqual(200)
    await container.item(key, tvmResponse.partitionKey).delete()

    // 2. forbidden database
    const badDatabase = client.database('someotherId')
    const containerBadDB = badDatabase.container(tvmResponse.containerId)
    let err
    try {
      await containerBadDB.items.upsert({ id: key, partitionKey: tvmResponse.partitionKey, value })
    } catch (e) {
      err = e
      expect(e.code).toEqual(403)
    }
    expect(err).toBeInstanceOf(Error)

    // 3. forbidden container
    const badContainer = database.container('someotherId')
    err = undefined
    try {
      await badContainer.items.upsert({ id: key, partitionKey: tvmResponse.partitionKey, value })
    } catch (e) {
      err = e
      expect(e.code).toEqual(403)
    }
    expect(err).toBeInstanceOf(Error)

    // 4. forbidden partitionKey
    err = undefined
    try {
      await badContainer.items.upsert({ id: key, partitionKey: 'someotherKey', value })
    } catch (e) {
      err = e
      expect(e.code).toEqual(403)
    }
    expect(err).toBeInstanceOf(Error)
  })
})

describe('e2e errors', () => {
  describe('auth related errors', () => {
    test('missing auth', async () => {
      process.env.__OW_NAMESPACE = testNamespace
      await expectBadArgument(TvmClient.init({ apiUrl }))
    })
    test('bad auth, good namespace', async () => {
      process.env.__OW_NAMESPACE = testNamespace
      process.env.__OW_API_KEY = 'BADAUTH'
      const tvm = await TvmClient.init({ apiUrl })
      await Promise.all(Object.values(functions).map(f => {
        return expectBadStatus(tvm[f](), 403)
      }))
    })
    test('bad namespace, good auth', async () => {
      process.env.__OW_NAMESPACE = 'badns'
      process.env.__OW_API_KEY = testAuth
      const tvm = await TvmClient.init({ apiUrl })
      await Promise.all(Object.values(functions).map(f => {
        return expectBadStatus(tvm[f](), 403)
      }))
    })
  })
})
