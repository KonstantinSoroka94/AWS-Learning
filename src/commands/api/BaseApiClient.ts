import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import _ from 'lodash';

export class BaseApiClient {
  #instance: AxiosInstance;

  #baseParams = {
    headers: {
      'Content-Type': 'application/json',
      Accept: '*/*',
    },
  };

  readonly defaultConfig: AxiosRequestConfig;

  constructor(axiosConfig: AxiosRequestConfig) {
    this.defaultConfig = _.merge({}, this.#baseParams, axiosConfig);
  }

  async processor(config: AxiosRequestConfig): Promise<AxiosResponse<any, AxiosRequestConfig>> {
    const axiosConfig = _.merge({}, this.defaultConfig, config);
    this.#instance = this.#instance ?? axios.create();
    return this.#instance.request(axiosConfig);
  }

  async get(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<any, AxiosRequestConfig>> {
    return this.processor({ ...config, url, method: 'GET' });
  }

  async post(url: string, data, config?: AxiosRequestConfig): Promise<AxiosResponse<any, AxiosRequestConfig>> {
    return this.processor({
      ...config,
      data,
      url,
      method: 'POST',
    });
  }

  async put(url: string, data, config?: AxiosRequestConfig): Promise<AxiosResponse<any, AxiosRequestConfig>> {
    return this.processor({
      ...config,
      data,
      url,
      method: 'PUT',
    });
  }

  async patch(url: string, data, config?: AxiosRequestConfig): Promise<AxiosResponse<any, AxiosRequestConfig>> {
    return this.processor({
      ...config,
      data,
      url,
      method: 'PATCH',
    });
  }

  async delete(url: string, data, config?: AxiosRequestConfig): Promise<AxiosResponse<any, AxiosRequestConfig>> {
    return this.processor({
      ...config,
      data,
      url,
      method: 'DELETE',
    });
  }
}
