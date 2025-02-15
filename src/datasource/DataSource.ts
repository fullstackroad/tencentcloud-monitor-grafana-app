import * as _ from 'lodash';
import {
  DataQueryRequest,
  DataQueryResponse,
  DataSourceInstanceSettings,
  LoadingState,
  LogRowModel,
  MetricFindValue,
} from '@grafana/data';
import { combineLatest, Observable, of, from } from 'rxjs';
import { map } from 'rxjs/operators';
import { DataSourceWithBackend, getBackendSrv, getTemplateSrv } from '@grafana/runtime';
import { TCMonitorDatasource } from './tc_monitor/MonitorDatasource';
import { MyDataSourceOptions, QueryInfo, ServiceType, VariableQuery } from './types';
import { LogServiceDataSource } from './log-service/LogServiceDataSource';
import RUMServiceDataSource from './rum-service/RUMServiceDataSource';
import { IS_DEVELOPMENT_ENVIRONMENT } from './common/constants';

/** 顶层数据源，内部根据配置与请求情况，请求具体的业务（monitor or logService） */
export class DataSource extends DataSourceWithBackend<QueryInfo, MyDataSourceOptions> {
  readonly instanceSettings: DataSourceInstanceSettings<MyDataSourceOptions>;
  readonly monitorDataSource: TCMonitorDatasource;
  readonly logServiceDataSource: LogServiceDataSource;
  readonly RUMServiceDataSource: RUMServiceDataSource;

  constructor(instanceSettings: DataSourceInstanceSettings<MyDataSourceOptions>) {
    super(instanceSettings);
    this.instanceSettings = instanceSettings;
    if (IS_DEVELOPMENT_ENVIRONMENT) {
      (window as any).tcDatasource = this;
    }

    this.monitorDataSource = new TCMonitorDatasource(this.instanceSettings, getBackendSrv(), getTemplateSrv()) as any;
    (this.monitorDataSource as any).meta = this.meta;
    this.logServiceDataSource = new LogServiceDataSource(this.instanceSettings);
    (this.logServiceDataSource as any).meta = this.meta;
    this.RUMServiceDataSource = new RUMServiceDataSource(this.instanceSettings);
    (this.RUMServiceDataSource as any).meta = this.meta;
  }

  query(request: DataQueryRequest<QueryInfo>): Observable<DataQueryResponse> {
    const monitorTargets: QueryInfo[] = [];
    const logServiceTargets: QueryInfo[] = [];
    const RUMServiceTargets: QueryInfo[] = [];
    for (const target of request.targets) {
      if (target.serviceType === ServiceType.logService) {
        logServiceTargets.push(target);
      } else if (target.serviceType === ServiceType.RUMService) {
        RUMServiceTargets.push(target);
      } else {
        monitorTargets.push(target);
      }
    }

    const EmptyDataQueryResponse: DataQueryResponse = { data: [], state: LoadingState.Done };
    return combineLatest<DataQueryResponse[]>([
      monitorTargets.length
        ? from(
            this.monitorDataSource.query({
              ..._.clone(_.omit(request, 'targets')),
              targets: monitorTargets,
            })
          )
        : of(EmptyDataQueryResponse),
      logServiceTargets.length
        ? this.logServiceDataSource.query({
            ..._.clone(_.omit(request, 'targets')),
            targets: logServiceTargets,
          })
        : of(EmptyDataQueryResponse),
      RUMServiceTargets.length
        ? this.RUMServiceDataSource.query({
            ..._.clone(_.omit(request, 'targets')),
            targets: RUMServiceTargets,
          })
        : of(EmptyDataQueryResponse),
    ]).pipe(
      map((responses: DataQueryResponse[]): DataQueryResponse => {
        const errResponse = responses.find((item) => item.state === LoadingState.Error);
        if (errResponse) {
          return errResponse;
        }
        if (!responses.every((item) => item.state === LoadingState.Done)) {
          return { data: [], state: LoadingState.Loading };
        }
        return {
          data: responses.map((item) => item.data).flat(1),
          state: LoadingState.Done,
        };
      })
    );
  }

  async testDatasource() {
    // 如果子服务没有开启，则返回null
    const serviceTestResults = (
      await Promise.all([this.monitorDataSource.testDatasource(), this.logServiceDataSource.testDatasource(), this.RUMServiceDataSource.testDatasource()])
    ).filter(Boolean);

    if (serviceTestResults.length === 0) {
      return {
        status: 'error',
        message: "Nothing configured. At least one of the API's services must be configured.",
      };
    }

    const failedResult = serviceTestResults.find((item) => item?.status !== 'success');
    if (failedResult) {
      return failedResult;
    } else {
      return serviceTestResults[0];
    }
  }

  async metricFindQuery(query: string | VariableQuery, options): Promise<MetricFindValue[]> {
    if (_.isString(query) || query.serviceType === ServiceType.monitor) {
      return this.monitorDataSource.metricFindQuery(_.isString(query) ? query : query.queryString, options);
    }
    if (query.serviceType === ServiceType.logService){
      return this.logServiceDataSource.metricFindQuery(query.logServiceParams, options);
    }
    if (query.serviceType === ServiceType.RUMService){
      return this.RUMServiceDataSource.metricFindQuery(query.queryString, options);
    }
    return [];
  }

  getLogRowContext = (row: LogRowModel, options) => {
    return this.logServiceDataSource.getLogRowContext(row, options);
  };

  showContextToggle = (row: LogRowModel) => {
    return false;
    // return this.logServiceDataSource.showContextToggle(row);
  };
}
