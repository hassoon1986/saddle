import { NetworkConfig } from './config';
import { TraceCollector, parseSourceMap } from '@0x/sol-tracing-utils';
import { TransactionReceipt } from 'web3-eth';
import { stripHexPrefix } from 'ethereumjs-util';
import chalk from 'chalk';
import Web3 from 'web3';
import { augmentLogs } from './trace/descriptor';

interface Trace {
  gas: number,
  returnValue: any,
  structLogs: StructLog[]
}

export interface TraceInfo {
  lastLog: undefined | StructLog,
  inv: InversionMap
}

export interface InversionItem {
  operation: string
  inputs: string[]
}

export interface InversionMap {
  [key: string]: InversionItem[]
}

export interface StructLog {
  depth: number,
  error: string,
  gas: number,
  gasCost: number,
  memory: null | string[],
  op: string,
  pc: number,
  stack: string[],
  storage: {[key: string]: string}
  source: undefined | any
  sourceLine: undefined | string,
  desc: undefined | string
  lastDesc: undefined | string
  sha: object
  show: undefined | (() => void)
}

export interface TraceOptions {
  constants?: {[key: string]: string},
  onTrace?: (Trace) => Promise<void>,
  preFilter?: undefined | ((log: StructLog) => boolean),
  postFilter?: undefined | ((log: StructLog) => boolean),
  execLog?: undefined | ((log: StructLog, info: TraceInfo) => Promise<void>)
  exec?: undefined | ((logs: StructLog[], info: TraceInfo) => Promise<void>)
}

function rpc(web3, request) {
  return new Promise((okay, fail) => web3.currentProvider.send(request, (err, res) => err ? fail(err) : okay(res)));
}

async function traceTransaction(web3, txHash, traceParams={}) {
  let {result} = <{result: Trace}>await rpc(web3, {method: 'debug_traceTransaction', params: [txHash, traceParams]});

  return result;
}

function getSource(offset, sourceFile) {
  let lines = sourceFile.slice(offset.location.start.line - 1, offset.location.end.line);
  let startCol = offset.location.start.column;
  let endCol = offset.location.end.column;
  let color = chalk.blueBright;
  let sourceLine = offset.location.start.line === offset.location.end.line ?
    `${offset.fileName}:${offset.location.start.line}[${offset.location.start.column}-${offset.location.end.column}]` :
    `${offset.fileName}:${offset.location.start.line}[${offset.location.start.column}]-${offset.location.end.line}[${offset.location.end.column}]`;

  let source = lines.reduce((result, line, i) => {
    let first = i === 0;
    let last = i === lines.length - 1;
    if (first && last) {
      // Single line
      return result + line.slice(0, startCol) + color(line.slice(startCol, endCol)) + line.slice(endCol);
    } else {
      if (first) {
        return result + line.slice(0, startCol) + color(line.slice(startCol));
      } else if (last) {
        return result + color(line.slice(0, endCol)) + line.slice(endCol);
      } else {
        return result + color(line)
      }
    }
  }, '');

  return {
    source,
    sourceLine
  };
}

export async function buildTracer(network_config: NetworkConfig) {
  let contractsData, traceCollector;
  if (network_config.artifactAdapter) {
    contractsData = await network_config.artifactAdapter.collectContractsDataAsync();
    traceCollector = new TraceCollector(network_config.artifactAdapter, true, <any>null);
  }

  return async function trace(receipt: TransactionReceipt, traceOpts: TraceOptions): Promise<any> {
    let pcToSourceRange, inverted;
    if (traceCollector) {
      let address = receipt.contractAddress || receipt.to;
      let isContractCreation = receipt.contractAddress !== null;
      let bytecode = await network_config.web3.eth.getCode(address);
      let contractData = await traceCollector.getContractDataByTraceInfoIfExistsAsync(address, bytecode, isContractCreation);

      if (!contractData) {
        throw new Error(`Failed to find contract data for given bytecode at ${address}`);
      }

      const bytecodeHex = stripHexPrefix(bytecode);
      const sourceMap = isContractCreation ? contractData.sourceMap : contractData.sourceMapRuntime;
      pcToSourceRange = parseSourceMap(contractData.sourceCodes, sourceMap, bytecodeHex, contractData.sources);
      inverted = Object.entries(contractData.sources).reduce((acc, [id, name]) => {
        return {
          ...acc,
          [<string>name]: contractData.sourceCodes[<string>id].split("\n")
        };
      }, {});
    };

    let trace = await traceTransaction(network_config.web3, receipt.transactionHash, {});

    if (traceOpts.onTrace) {
      await traceOpts.onTrace(trace);
    }

    let {logs: augmentedLogs, info: info} = augmentLogs(trace.structLogs, traceOpts.constants || {});
    let filteredLogs = traceOpts.preFilter ? augmentedLogs.filter(traceOpts.preFilter) : augmentedLogs;

    if (pcToSourceRange && inverted) {
      filteredLogs = filteredLogs.map((log, i) => {
        let offset = pcToSourceRange[log.pc];
        let sourceFile = inverted[offset.fileName];

        return {
          ...log,
          ...getSource(offset, sourceFile)
        }
      });
    }

    let postFilteredLogs = traceOpts.postFilter ? filteredLogs.filter(traceOpts.postFilter) : filteredLogs;

    if (traceOpts.execLog !== undefined) {
      let {execLog} = traceOpts;

      await Promise.all(postFilteredLogs.map((log) => execLog(log, info)));
    }

    if (traceOpts.exec !== undefined) {
      await traceOpts.exec(postFilteredLogs, info);
    }

    return postFilteredLogs;
  }
}
