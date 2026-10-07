// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.
// Standalone generator: ajv 8.20.0 (MIT).
// The MIT License (MIT)
//
// Copyright (c) 2015-2021 Evgeny Poberezkin
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
"use strict";
export const validate = validate255;
export default validate255;
const schema278 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"TextReviewCheckReport","description":"A successful report includes one explicit outcome for every selected rule.\nFailed/cancelled/unavailable outcomes are not converted to passed coverage.","type":"object","properties":{"diagnostics":{"type":"array","items":{"$ref":"#/$defs/TextReviewDiagnostic"}},"results":{"type":"array","items":{"$ref":"#/$defs/CheckResult"}}},"additionalProperties":false,"required":["results","diagnostics"],"$defs":{"CheckFinding":{"type":"object","properties":{"code":{"type":"string"},"severity":{"$ref":"#/$defs/FindingSeverity"},"target":{"type":"string"}},"additionalProperties":false,"required":["code","target","severity"]},"CheckImplementation":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"core"},"validator":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["kind","validator"]},{"type":"object","properties":{"kind":{"type":"string","const":"plugin"},"provider":{"$ref":"#/$defs/ProviderSelectionBinding"}},"additionalProperties":false,"required":["kind","provider"]}]},"CheckKey":{"type":"object","properties":{"implementation":{"$ref":"#/$defs/CheckImplementation"},"rule":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["rule","implementation"]},"CheckOutcome":{"oneOf":[{"type":"object","properties":{"findings":{"type":"array","items":{"$ref":"#/$defs/CheckFinding"}},"kind":{"type":"string","const":"completed"}},"additionalProperties":false,"required":["kind","findings"]},{"type":"object","properties":{"basis":{"$ref":"#/$defs/NotApplicableBasis"},"kind":{"type":"string","const":"not-applicable"}},"additionalProperties":false,"required":["kind","basis"]},{"type":"object","properties":{"kind":{"type":"string","const":"failed"}},"additionalProperties":false,"required":["kind"]},{"type":"object","properties":{"kind":{"type":"string","const":"cancelled"}},"additionalProperties":false,"required":["kind"]},{"type":"object","properties":{"kind":{"type":"string","const":"unavailable"}},"additionalProperties":false,"required":["kind"]}]},"CheckResult":{"type":"object","properties":{"coveredTargets":{"type":"array","items":{"type":"string"}},"inputDigest":{"type":"string"},"key":{"$ref":"#/$defs/CheckKey"},"outcome":{"$ref":"#/$defs/CheckOutcome"},"scopeDigest":{"type":"string"}},"additionalProperties":false,"required":["key","inputDigest","scopeDigest","coveredTargets","outcome"]},"ContractRef":{"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]},"FindingSeverity":{"type":"string","enum":["warning","error"]},"NotApplicableBasis":{"description":"A trusted capture of an allowed reason and its exact scope basis, not a\nplugin's claim that it is safe to skip a required check.","type":"object","properties":{"basisDigest":{"type":"string"},"code":{"type":"string"}},"additionalProperties":false,"required":["code","basisDigest"]},"PluginIdentity":{"description":"Claimed package identity; a host must authenticate the actual package source.","type":"object","properties":{"id":{"type":"string"},"publisher":{"type":"string"},"version":{"type":"string"}},"additionalProperties":false,"required":["publisher","id","version"]},"ProviderSelectionBinding":{"description":"A fixed package/contribution choice, independent of any active instance.\nIts digest is supplied by the trusted package owner; this value neither\nauthenticates those bytes nor grants permission to load or call them.","type":"object","properties":{"componentId":{"type":"string"},"contributionId":{"type":"string"},"packageDigest":{"type":"string"},"plugin":{"$ref":"#/$defs/PluginIdentity"}},"additionalProperties":false,"required":["plugin","componentId","contributionId","packageDigest"]},"TextEncoding":{"type":"string","enum":["utf8-byte","utf16","grapheme"]},"TextRange":{"description":"Half-open offsets into one exact string, never between different strings.","type":"object","properties":{"encoding":{"$ref":"#/$defs/TextEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]},"TextReviewDiagnostic":{"description":"Optional public presentation associated with one actual finding. Diagnostic\nprose is not authenticated or sanitized by these structural checks.","type":"object","properties":{"code":{"type":"string"},"detail":{"type":["string","null"]},"key":{"$ref":"#/$defs/CheckKey"},"location":{"anyOf":[{"$ref":"#/$defs/TextReviewLocation"},{"type":"null"}]},"resourceEntry":{"anyOf":[{"$ref":"#/$defs/TextReviewResourceEntry"},{"type":"null"}]},"suggestion":{"type":["string","null"]},"target":{"type":"string"}},"additionalProperties":false,"required":["key","code","target"]},"TextReviewField":{"type":"string","enum":["source","translation"]},"TextReviewLocation":{"type":"object","properties":{"field":{"$ref":"#/$defs/TextReviewField"},"range":{"$ref":"#/$defs/TextRange"}},"additionalProperties":false,"required":["field","range"]},"TextReviewResourceEntry":{"type":"object","properties":{"contributionId":{"type":"string"},"entryId":{"type":"string"}},"additionalProperties":false,"required":["contributionId","entryId"]}}};
const schema279 = {"description":"Optional public presentation associated with one actual finding. Diagnostic\nprose is not authenticated or sanitized by these structural checks.","type":"object","properties":{"code":{"type":"string"},"detail":{"type":["string","null"]},"key":{"$ref":"#/$defs/CheckKey"},"location":{"anyOf":[{"$ref":"#/$defs/TextReviewLocation"},{"type":"null"}]},"resourceEntry":{"anyOf":[{"$ref":"#/$defs/TextReviewResourceEntry"},{"type":"null"}]},"suggestion":{"type":["string","null"]},"target":{"type":"string"}},"additionalProperties":false,"required":["key","code","target"]};
const schema290 = {"type":"object","properties":{"contributionId":{"type":"string"},"entryId":{"type":"string"}},"additionalProperties":false,"required":["contributionId","entryId"]};
const schema280 = {"type":"object","properties":{"implementation":{"$ref":"#/$defs/CheckImplementation"},"rule":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["rule","implementation"]};
const schema282 = {"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]};
const schema281 = {"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"core"},"validator":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["kind","validator"]},{"type":"object","properties":{"kind":{"type":"string","const":"plugin"},"provider":{"$ref":"#/$defs/ProviderSelectionBinding"}},"additionalProperties":false,"required":["kind","provider"]}]};
const schema283 = {"description":"A fixed package/contribution choice, independent of any active instance.\nIts digest is supplied by the trusted package owner; this value neither\nauthenticates those bytes nor grants permission to load or call them.","type":"object","properties":{"componentId":{"type":"string"},"contributionId":{"type":"string"},"packageDigest":{"type":"string"},"plugin":{"$ref":"#/$defs/PluginIdentity"}},"additionalProperties":false,"required":["plugin","componentId","contributionId","packageDigest"]};
const schema284 = {"description":"Claimed package identity; a host must authenticate the actual package source.","type":"object","properties":{"id":{"type":"string"},"publisher":{"type":"string"},"version":{"type":"string"}},"additionalProperties":false,"required":["publisher","id","version"]};

function validate259(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate259.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((data.plugin === undefined) && (missing0 = "plugin")) || ((data.componentId === undefined) && (missing0 = "componentId"))) || ((data.contributionId === undefined) && (missing0 = "contributionId"))) || ((data.packageDigest === undefined) && (missing0 = "packageDigest"))){
validate259.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "componentId") || (key0 === "contributionId")) || (key0 === "packageDigest")) || (key0 === "plugin"))){
validate259.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.componentId !== undefined){
const _errs2 = errors;
if(typeof data.componentId !== "string"){
validate259.errors = [{instancePath:instancePath+"/componentId",schemaPath:"#/properties/componentId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.contributionId !== undefined){
const _errs4 = errors;
if(typeof data.contributionId !== "string"){
validate259.errors = [{instancePath:instancePath+"/contributionId",schemaPath:"#/properties/contributionId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.packageDigest !== undefined){
const _errs6 = errors;
if(typeof data.packageDigest !== "string"){
validate259.errors = [{instancePath:instancePath+"/packageDigest",schemaPath:"#/properties/packageDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs6 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.plugin !== undefined){
let data3 = data.plugin;
const _errs8 = errors;
const _errs9 = errors;
if(errors === _errs9){
if(data3 && typeof data3 == "object" && !Array.isArray(data3)){
let missing1;
if((((data3.publisher === undefined) && (missing1 = "publisher")) || ((data3.id === undefined) && (missing1 = "id"))) || ((data3.version === undefined) && (missing1 = "version"))){
validate259.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs11 = errors;
for(const key1 in data3){
if(!(((key1 === "id") || (key1 === "publisher")) || (key1 === "version"))){
validate259.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs11 === errors){
if(data3.id !== undefined){
const _errs12 = errors;
if(typeof data3.id !== "string"){
validate259.errors = [{instancePath:instancePath+"/plugin/id",schemaPath:"#/$defs/PluginIdentity/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs12 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data3.publisher !== undefined){
const _errs14 = errors;
if(typeof data3.publisher !== "string"){
validate259.errors = [{instancePath:instancePath+"/plugin/publisher",schemaPath:"#/$defs/PluginIdentity/properties/publisher/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs14 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data3.version !== undefined){
const _errs16 = errors;
if(typeof data3.version !== "string"){
validate259.errors = [{instancePath:instancePath+"/plugin/version",schemaPath:"#/$defs/PluginIdentity/properties/version/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs16 === errors;
}
else {
var valid2 = true;
}
}
}
}
}
}
else {
validate259.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs8 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
}
else {
validate259.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate259.errors = vErrors;
return errors === 0;
}
validate259.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate258(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate258.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
const _errs0 = errors;
let valid0 = false;
let passing0 = null;
const _errs1 = errors;
if(errors === _errs1){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.kind === undefined) && (missing0 = "kind")) || ((data.validator === undefined) && (missing0 = "validator"))){
const err0 = {instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
else {
const _errs3 = errors;
for(const key0 in data){
if(!((key0 === "kind") || (key0 === "validator"))){
const err1 = {instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
break;
}
}
if(_errs3 === errors){
if(data.kind !== undefined){
let data0 = data.kind;
const _errs4 = errors;
if(typeof data0 !== "string"){
const err2 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
if("core" !== data0){
const err3 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "core"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
var valid1 = _errs4 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.validator !== undefined){
let data1 = data.validator;
const _errs6 = errors;
const _errs7 = errors;
if(errors === _errs7){
if(data1 && typeof data1 == "object" && !Array.isArray(data1)){
let missing1;
if((((data1.id === undefined) && (missing1 = "id")) || ((data1.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data1.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
const err4 = {instancePath:instancePath+"/validator",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
else {
const _errs9 = errors;
for(const key1 in data1){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
const err5 = {instancePath:instancePath+"/validator",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
break;
}
}
if(_errs9 === errors){
if(data1.behaviorVersion !== undefined){
let data2 = data1.behaviorVersion;
const _errs10 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
const err6 = {instancePath:instancePath+"/validator/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
if(errors === _errs10){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
const err7 = {instancePath:instancePath+"/validator/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
else {
if(data2 < 1 || isNaN(data2)){
const err8 = {instancePath:instancePath+"/validator/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
}
}
}
var valid3 = _errs10 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.id !== undefined){
const _errs12 = errors;
if(typeof data1.id !== "string"){
const err9 = {instancePath:instancePath+"/validator/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
var valid3 = _errs12 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.schemaVersion !== undefined){
let data4 = data1.schemaVersion;
const _errs14 = errors;
if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){
const err10 = {instancePath:instancePath+"/validator/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
if(errors === _errs14){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
const err11 = {instancePath:instancePath+"/validator/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
else {
if(data4 < 1 || isNaN(data4)){
const err12 = {instancePath:instancePath+"/validator/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
}
}
}
var valid3 = _errs14 === errors;
}
else {
var valid3 = true;
}
}
}
}
}
}
else {
const err13 = {instancePath:instancePath+"/validator",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
}
var valid1 = _errs6 === errors;
}
else {
var valid1 = true;
}
}
}
}
}
else {
const err14 = {instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
}
var _valid0 = _errs1 === errors;
if(_valid0){
valid0 = true;
passing0 = 0;
var props0 = true;
}
const _errs16 = errors;
if(errors === _errs16){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing2;
if(((data.kind === undefined) && (missing2 = "kind")) || ((data.provider === undefined) && (missing2 = "provider"))){
const err15 = {instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
else {
const _errs18 = errors;
for(const key2 in data){
if(!((key2 === "kind") || (key2 === "provider"))){
const err16 = {instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
break;
}
}
if(_errs18 === errors){
if(data.kind !== undefined){
let data5 = data.kind;
const _errs19 = errors;
if(typeof data5 !== "string"){
const err17 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
if("plugin" !== data5){
const err18 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "plugin"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
var valid4 = _errs19 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.provider !== undefined){
const _errs21 = errors;
if(!(validate259(data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate259.errors : vErrors.concat(validate259.errors);
errors = vErrors.length;
}
var valid4 = _errs21 === errors;
}
else {
var valid4 = true;
}
}
}
}
}
else {
const err19 = {instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
}
var _valid0 = _errs16 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 1];
}
else {
if(_valid0){
valid0 = true;
passing0 = 1;
if(props0 !== true){
props0 = true;
}
}
}
if(!valid0){
const err20 = {instancePath,schemaPath:"#/oneOf",keyword:"oneOf",params:{passingSchemas: passing0},message:"must match exactly one schema in oneOf"};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
validate258.errors = vErrors;
return false;
}
else {
errors = _errs0;
if(vErrors !== null){
if(_errs0){
vErrors.length = _errs0;
}
else {
vErrors = null;
}
}
}
validate258.errors = vErrors;
evaluated0.props = props0;
return errors === 0;
}
validate258.evaluated = {"dynamicProps":true,"dynamicItems":false};


function validate257(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate257.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.rule === undefined) && (missing0 = "rule")) || ((data.implementation === undefined) && (missing0 = "implementation"))){
validate257.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "implementation") || (key0 === "rule"))){
validate257.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.implementation !== undefined){
const _errs2 = errors;
if(!(validate258(data.implementation, {instancePath:instancePath+"/implementation",parentData:data,parentDataProperty:"implementation",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate258.errors : vErrors.concat(validate258.errors);
errors = vErrors.length;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.rule !== undefined){
let data1 = data.rule;
const _errs3 = errors;
const _errs4 = errors;
if(errors === _errs4){
if(data1 && typeof data1 == "object" && !Array.isArray(data1)){
let missing1;
if((((data1.id === undefined) && (missing1 = "id")) || ((data1.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data1.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate257.errors = [{instancePath:instancePath+"/rule",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs6 = errors;
for(const key1 in data1){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate257.errors = [{instancePath:instancePath+"/rule",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs6 === errors){
if(data1.behaviorVersion !== undefined){
let data2 = data1.behaviorVersion;
const _errs7 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate257.errors = [{instancePath:instancePath+"/rule/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs7){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate257.errors = [{instancePath:instancePath+"/rule/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 1 || isNaN(data2)){
validate257.errors = [{instancePath:instancePath+"/rule/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs7 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.id !== undefined){
const _errs9 = errors;
if(typeof data1.id !== "string"){
validate257.errors = [{instancePath:instancePath+"/rule/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs9 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.schemaVersion !== undefined){
let data4 = data1.schemaVersion;
const _errs11 = errors;
if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){
validate257.errors = [{instancePath:instancePath+"/rule/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs11){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
validate257.errors = [{instancePath:instancePath+"/rule/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data4 < 1 || isNaN(data4)){
validate257.errors = [{instancePath:instancePath+"/rule/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs11 === errors;
}
else {
var valid2 = true;
}
}
}
}
}
}
else {
validate257.errors = [{instancePath:instancePath+"/rule",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs3 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
else {
validate257.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate257.errors = vErrors;
return errors === 0;
}
validate257.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema286 = {"type":"object","properties":{"field":{"$ref":"#/$defs/TextReviewField"},"range":{"$ref":"#/$defs/TextRange"}},"additionalProperties":false,"required":["field","range"]};
const schema287 = {"type":"string","enum":["source","translation"]};
const schema288 = {"description":"Half-open offsets into one exact string, never between different strings.","type":"object","properties":{"encoding":{"$ref":"#/$defs/TextEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]};
const schema289 = {"type":"string","enum":["utf8-byte","utf16","grapheme"]};

function validate264(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate264.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((data.encoding === undefined) && (missing0 = "encoding")) || ((data.start === undefined) && (missing0 = "start"))) || ((data.end === undefined) && (missing0 = "end"))){
validate264.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "encoding") || (key0 === "end")) || (key0 === "start"))){
validate264.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.encoding !== undefined){
let data0 = data.encoding;
const _errs2 = errors;
if(typeof data0 !== "string"){
validate264.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/TextEncoding/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(((data0 === "utf8-byte") || (data0 === "utf16")) || (data0 === "grapheme"))){
validate264.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/TextEncoding/enum",keyword:"enum",params:{allowedValues: schema289.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.end !== undefined){
let data1 = data.end;
const _errs5 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate264.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs5){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate264.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 0 || isNaN(data1)){
validate264.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.start !== undefined){
let data2 = data.start;
const _errs7 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate264.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs7){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate264.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 0 || isNaN(data2)){
validate264.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid0 = _errs7 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
else {
validate264.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate264.errors = vErrors;
return errors === 0;
}
validate264.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate263(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate263.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.field === undefined) && (missing0 = "field")) || ((data.range === undefined) && (missing0 = "range"))){
validate263.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "field") || (key0 === "range"))){
validate263.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.field !== undefined){
let data0 = data.field;
const _errs2 = errors;
if(typeof data0 !== "string"){
validate263.errors = [{instancePath:instancePath+"/field",schemaPath:"#/$defs/TextReviewField/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!((data0 === "source") || (data0 === "translation"))){
validate263.errors = [{instancePath:instancePath+"/field",schemaPath:"#/$defs/TextReviewField/enum",keyword:"enum",params:{allowedValues: schema287.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.range !== undefined){
const _errs5 = errors;
if(!(validate264(data.range, {instancePath:instancePath+"/range",parentData:data,parentDataProperty:"range",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate264.errors : vErrors.concat(validate264.errors);
errors = vErrors.length;
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
else {
validate263.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate263.errors = vErrors;
return errors === 0;
}
validate263.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate256(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate256.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((data.key === undefined) && (missing0 = "key")) || ((data.code === undefined) && (missing0 = "code"))) || ((data.target === undefined) && (missing0 = "target"))){
validate256.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((((((key0 === "code") || (key0 === "detail")) || (key0 === "key")) || (key0 === "location")) || (key0 === "resourceEntry")) || (key0 === "suggestion")) || (key0 === "target"))){
validate256.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.code !== undefined){
const _errs2 = errors;
if(typeof data.code !== "string"){
validate256.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.detail !== undefined){
let data1 = data.detail;
const _errs4 = errors;
if((typeof data1 !== "string") && (data1 !== null)){
validate256.errors = [{instancePath:instancePath+"/detail",schemaPath:"#/properties/detail/type",keyword:"type",params:{type: schema279.properties.detail.type},message:"must be string,null"}];
return false;
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.key !== undefined){
const _errs6 = errors;
if(!(validate257(data.key, {instancePath:instancePath+"/key",parentData:data,parentDataProperty:"key",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate257.errors : vErrors.concat(validate257.errors);
errors = vErrors.length;
}
var valid0 = _errs6 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.location !== undefined){
let data3 = data.location;
const _errs7 = errors;
const _errs8 = errors;
let valid1 = false;
const _errs9 = errors;
if(!(validate263(data3, {instancePath:instancePath+"/location",parentData:data,parentDataProperty:"location",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate263.errors : vErrors.concat(validate263.errors);
errors = vErrors.length;
}
var _valid0 = _errs9 === errors;
valid1 = valid1 || _valid0;
const _errs10 = errors;
if(data3 !== null){
const err0 = {instancePath:instancePath+"/location",schemaPath:"#/properties/location/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
var _valid0 = _errs10 === errors;
valid1 = valid1 || _valid0;
if(!valid1){
const err1 = {instancePath:instancePath+"/location",schemaPath:"#/properties/location/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
validate256.errors = vErrors;
return false;
}
else {
errors = _errs8;
if(vErrors !== null){
if(_errs8){
vErrors.length = _errs8;
}
else {
vErrors = null;
}
}
}
var valid0 = _errs7 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.resourceEntry !== undefined){
let data4 = data.resourceEntry;
const _errs12 = errors;
const _errs13 = errors;
let valid2 = false;
const _errs14 = errors;
const _errs15 = errors;
if(errors === _errs15){
if(data4 && typeof data4 == "object" && !Array.isArray(data4)){
let missing1;
if(((data4.contributionId === undefined) && (missing1 = "contributionId")) || ((data4.entryId === undefined) && (missing1 = "entryId"))){
const err2 = {instancePath:instancePath+"/resourceEntry",schemaPath:"#/$defs/TextReviewResourceEntry/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
else {
const _errs17 = errors;
for(const key1 in data4){
if(!((key1 === "contributionId") || (key1 === "entryId"))){
const err3 = {instancePath:instancePath+"/resourceEntry",schemaPath:"#/$defs/TextReviewResourceEntry/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
break;
}
}
if(_errs17 === errors){
if(data4.contributionId !== undefined){
const _errs18 = errors;
if(typeof data4.contributionId !== "string"){
const err4 = {instancePath:instancePath+"/resourceEntry/contributionId",schemaPath:"#/$defs/TextReviewResourceEntry/properties/contributionId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
var valid4 = _errs18 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data4.entryId !== undefined){
const _errs20 = errors;
if(typeof data4.entryId !== "string"){
const err5 = {instancePath:instancePath+"/resourceEntry/entryId",schemaPath:"#/$defs/TextReviewResourceEntry/properties/entryId/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
var valid4 = _errs20 === errors;
}
else {
var valid4 = true;
}
}
}
}
}
else {
const err6 = {instancePath:instancePath+"/resourceEntry",schemaPath:"#/$defs/TextReviewResourceEntry/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
}
var _valid1 = _errs14 === errors;
valid2 = valid2 || _valid1;
const _errs22 = errors;
if(data4 !== null){
const err7 = {instancePath:instancePath+"/resourceEntry",schemaPath:"#/properties/resourceEntry/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
var _valid1 = _errs22 === errors;
valid2 = valid2 || _valid1;
if(!valid2){
const err8 = {instancePath:instancePath+"/resourceEntry",schemaPath:"#/properties/resourceEntry/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
validate256.errors = vErrors;
return false;
}
else {
errors = _errs13;
if(vErrors !== null){
if(_errs13){
vErrors.length = _errs13;
}
else {
vErrors = null;
}
}
}
var valid0 = _errs12 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.suggestion !== undefined){
let data7 = data.suggestion;
const _errs24 = errors;
if((typeof data7 !== "string") && (data7 !== null)){
validate256.errors = [{instancePath:instancePath+"/suggestion",schemaPath:"#/properties/suggestion/type",keyword:"type",params:{type: schema279.properties.suggestion.type},message:"must be string,null"}];
return false;
}
var valid0 = _errs24 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.target !== undefined){
const _errs26 = errors;
if(typeof data.target !== "string"){
validate256.errors = [{instancePath:instancePath+"/target",schemaPath:"#/properties/target/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs26 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
}
}
}
}
else {
validate256.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate256.errors = vErrors;
return errors === 0;
}
validate256.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema291 = {"type":"object","properties":{"coveredTargets":{"type":"array","items":{"type":"string"}},"inputDigest":{"type":"string"},"key":{"$ref":"#/$defs/CheckKey"},"outcome":{"$ref":"#/$defs/CheckOutcome"},"scopeDigest":{"type":"string"}},"additionalProperties":false,"required":["key","inputDigest","scopeDigest","coveredTargets","outcome"]};
const schema292 = {"oneOf":[{"type":"object","properties":{"findings":{"type":"array","items":{"$ref":"#/$defs/CheckFinding"}},"kind":{"type":"string","const":"completed"}},"additionalProperties":false,"required":["kind","findings"]},{"type":"object","properties":{"basis":{"$ref":"#/$defs/NotApplicableBasis"},"kind":{"type":"string","const":"not-applicable"}},"additionalProperties":false,"required":["kind","basis"]},{"type":"object","properties":{"kind":{"type":"string","const":"failed"}},"additionalProperties":false,"required":["kind"]},{"type":"object","properties":{"kind":{"type":"string","const":"cancelled"}},"additionalProperties":false,"required":["kind"]},{"type":"object","properties":{"kind":{"type":"string","const":"unavailable"}},"additionalProperties":false,"required":["kind"]}]};
const schema295 = {"description":"A trusted capture of an allowed reason and its exact scope basis, not a\nplugin's claim that it is safe to skip a required check.","type":"object","properties":{"basisDigest":{"type":"string"},"code":{"type":"string"}},"additionalProperties":false,"required":["code","basisDigest"]};
const schema293 = {"type":"object","properties":{"code":{"type":"string"},"severity":{"$ref":"#/$defs/FindingSeverity"},"target":{"type":"string"}},"additionalProperties":false,"required":["code","target","severity"]};
const schema294 = {"type":"string","enum":["warning","error"]};

function validate271(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate271.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((data.code === undefined) && (missing0 = "code")) || ((data.target === undefined) && (missing0 = "target"))) || ((data.severity === undefined) && (missing0 = "severity"))){
validate271.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "code") || (key0 === "severity")) || (key0 === "target"))){
validate271.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.code !== undefined){
const _errs2 = errors;
if(typeof data.code !== "string"){
validate271.errors = [{instancePath:instancePath+"/code",schemaPath:"#/properties/code/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.severity !== undefined){
let data1 = data.severity;
const _errs4 = errors;
if(typeof data1 !== "string"){
validate271.errors = [{instancePath:instancePath+"/severity",schemaPath:"#/$defs/FindingSeverity/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!((data1 === "warning") || (data1 === "error"))){
validate271.errors = [{instancePath:instancePath+"/severity",schemaPath:"#/$defs/FindingSeverity/enum",keyword:"enum",params:{allowedValues: schema294.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.target !== undefined){
const _errs7 = errors;
if(typeof data.target !== "string"){
validate271.errors = [{instancePath:instancePath+"/target",schemaPath:"#/properties/target/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs7 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
else {
validate271.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate271.errors = vErrors;
return errors === 0;
}
validate271.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate270(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate270.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
const _errs0 = errors;
let valid0 = false;
let passing0 = null;
const _errs1 = errors;
if(errors === _errs1){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.kind === undefined) && (missing0 = "kind")) || ((data.findings === undefined) && (missing0 = "findings"))){
const err0 = {instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
else {
const _errs3 = errors;
for(const key0 in data){
if(!((key0 === "findings") || (key0 === "kind"))){
const err1 = {instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
break;
}
}
if(_errs3 === errors){
if(data.findings !== undefined){
let data0 = data.findings;
const _errs4 = errors;
if(errors === _errs4){
if(Array.isArray(data0)){
var valid2 = true;
const len0 = data0.length;
for(let i0=0; i0<len0; i0++){
const _errs6 = errors;
if(!(validate271(data0[i0], {instancePath:instancePath+"/findings/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate271.errors : vErrors.concat(validate271.errors);
errors = vErrors.length;
}
var valid2 = _errs6 === errors;
if(!valid2){
break;
}
}
}
else {
const err2 = {instancePath:instancePath+"/findings",schemaPath:"#/oneOf/0/properties/findings/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
}
var valid1 = _errs4 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.kind !== undefined){
let data2 = data.kind;
const _errs7 = errors;
if(typeof data2 !== "string"){
const err3 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
if("completed" !== data2){
const err4 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "completed"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
var valid1 = _errs7 === errors;
}
else {
var valid1 = true;
}
}
}
}
}
else {
const err5 = {instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
}
var _valid0 = _errs1 === errors;
if(_valid0){
valid0 = true;
passing0 = 0;
var props0 = true;
}
const _errs9 = errors;
if(errors === _errs9){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing1;
if(((data.kind === undefined) && (missing1 = "kind")) || ((data.basis === undefined) && (missing1 = "basis"))){
const err6 = {instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
else {
const _errs11 = errors;
for(const key1 in data){
if(!((key1 === "basis") || (key1 === "kind"))){
const err7 = {instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
break;
}
}
if(_errs11 === errors){
if(data.basis !== undefined){
let data3 = data.basis;
const _errs12 = errors;
const _errs13 = errors;
if(errors === _errs13){
if(data3 && typeof data3 == "object" && !Array.isArray(data3)){
let missing2;
if(((data3.code === undefined) && (missing2 = "code")) || ((data3.basisDigest === undefined) && (missing2 = "basisDigest"))){
const err8 = {instancePath:instancePath+"/basis",schemaPath:"#/$defs/NotApplicableBasis/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
else {
const _errs15 = errors;
for(const key2 in data3){
if(!((key2 === "basisDigest") || (key2 === "code"))){
const err9 = {instancePath:instancePath+"/basis",schemaPath:"#/$defs/NotApplicableBasis/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
break;
}
}
if(_errs15 === errors){
if(data3.basisDigest !== undefined){
const _errs16 = errors;
if(typeof data3.basisDigest !== "string"){
const err10 = {instancePath:instancePath+"/basis/basisDigest",schemaPath:"#/$defs/NotApplicableBasis/properties/basisDigest/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
var valid5 = _errs16 === errors;
}
else {
var valid5 = true;
}
if(valid5){
if(data3.code !== undefined){
const _errs18 = errors;
if(typeof data3.code !== "string"){
const err11 = {instancePath:instancePath+"/basis/code",schemaPath:"#/$defs/NotApplicableBasis/properties/code/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
var valid5 = _errs18 === errors;
}
else {
var valid5 = true;
}
}
}
}
}
else {
const err12 = {instancePath:instancePath+"/basis",schemaPath:"#/$defs/NotApplicableBasis/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
}
var valid3 = _errs12 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data.kind !== undefined){
let data6 = data.kind;
const _errs20 = errors;
if(typeof data6 !== "string"){
const err13 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
if("not-applicable" !== data6){
const err14 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "not-applicable"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
var valid3 = _errs20 === errors;
}
else {
var valid3 = true;
}
}
}
}
}
else {
const err15 = {instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
}
var _valid0 = _errs9 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 1];
}
else {
if(_valid0){
valid0 = true;
passing0 = 1;
if(props0 !== true){
props0 = true;
}
}
const _errs22 = errors;
if(errors === _errs22){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing3;
if((data.kind === undefined) && (missing3 = "kind")){
const err16 = {instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing3},message:"must have required property '"+missing3+"'"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
}
else {
const _errs24 = errors;
for(const key3 in data){
if(!(key3 === "kind")){
const err17 = {instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
break;
}
}
if(_errs24 === errors){
if(data.kind !== undefined){
let data7 = data.kind;
if(typeof data7 !== "string"){
const err18 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
if("failed" !== data7){
const err19 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "failed"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
}
}
}
}
else {
const err20 = {instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
}
}
var _valid0 = _errs22 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 2];
}
else {
if(_valid0){
valid0 = true;
passing0 = 2;
if(props0 !== true){
props0 = true;
}
}
const _errs27 = errors;
if(errors === _errs27){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing4;
if((data.kind === undefined) && (missing4 = "kind")){
const err21 = {instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing4},message:"must have required property '"+missing4+"'"};
if(vErrors === null){
vErrors = [err21];
}
else {
vErrors.push(err21);
}
errors++;
}
else {
const _errs29 = errors;
for(const key4 in data){
if(!(key4 === "kind")){
const err22 = {instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err22];
}
else {
vErrors.push(err22);
}
errors++;
break;
}
}
if(_errs29 === errors){
if(data.kind !== undefined){
let data8 = data.kind;
if(typeof data8 !== "string"){
const err23 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err23];
}
else {
vErrors.push(err23);
}
errors++;
}
if("cancelled" !== data8){
const err24 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/3/properties/kind/const",keyword:"const",params:{allowedValue: "cancelled"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err24];
}
else {
vErrors.push(err24);
}
errors++;
}
}
}
}
}
else {
const err25 = {instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err25];
}
else {
vErrors.push(err25);
}
errors++;
}
}
var _valid0 = _errs27 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 3];
}
else {
if(_valid0){
valid0 = true;
passing0 = 3;
if(props0 !== true){
props0 = true;
}
}
const _errs32 = errors;
if(errors === _errs32){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing5;
if((data.kind === undefined) && (missing5 = "kind")){
const err26 = {instancePath,schemaPath:"#/oneOf/4/required",keyword:"required",params:{missingProperty: missing5},message:"must have required property '"+missing5+"'"};
if(vErrors === null){
vErrors = [err26];
}
else {
vErrors.push(err26);
}
errors++;
}
else {
const _errs34 = errors;
for(const key5 in data){
if(!(key5 === "kind")){
const err27 = {instancePath,schemaPath:"#/oneOf/4/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err27];
}
else {
vErrors.push(err27);
}
errors++;
break;
}
}
if(_errs34 === errors){
if(data.kind !== undefined){
let data9 = data.kind;
if(typeof data9 !== "string"){
const err28 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err28];
}
else {
vErrors.push(err28);
}
errors++;
}
if("unavailable" !== data9){
const err29 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/4/properties/kind/const",keyword:"const",params:{allowedValue: "unavailable"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err29];
}
else {
vErrors.push(err29);
}
errors++;
}
}
}
}
}
else {
const err30 = {instancePath,schemaPath:"#/oneOf/4/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err30];
}
else {
vErrors.push(err30);
}
errors++;
}
}
var _valid0 = _errs32 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 4];
}
else {
if(_valid0){
valid0 = true;
passing0 = 4;
if(props0 !== true){
props0 = true;
}
}
}
}
}
}
if(!valid0){
const err31 = {instancePath,schemaPath:"#/oneOf",keyword:"oneOf",params:{passingSchemas: passing0},message:"must match exactly one schema in oneOf"};
if(vErrors === null){
vErrors = [err31];
}
else {
vErrors.push(err31);
}
errors++;
validate270.errors = vErrors;
return false;
}
else {
errors = _errs0;
if(vErrors !== null){
if(_errs0){
vErrors.length = _errs0;
}
else {
vErrors = null;
}
}
}
validate270.errors = vErrors;
evaluated0.props = props0;
return errors === 0;
}
validate270.evaluated = {"dynamicProps":true,"dynamicItems":false};


function validate268(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate268.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((((data.key === undefined) && (missing0 = "key")) || ((data.inputDigest === undefined) && (missing0 = "inputDigest"))) || ((data.scopeDigest === undefined) && (missing0 = "scopeDigest"))) || ((data.coveredTargets === undefined) && (missing0 = "coveredTargets"))) || ((data.outcome === undefined) && (missing0 = "outcome"))){
validate268.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((((key0 === "coveredTargets") || (key0 === "inputDigest")) || (key0 === "key")) || (key0 === "outcome")) || (key0 === "scopeDigest"))){
validate268.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.coveredTargets !== undefined){
let data0 = data.coveredTargets;
const _errs2 = errors;
if(errors === _errs2){
if(Array.isArray(data0)){
var valid1 = true;
const len0 = data0.length;
for(let i0=0; i0<len0; i0++){
const _errs4 = errors;
if(typeof data0[i0] !== "string"){
validate268.errors = [{instancePath:instancePath+"/coveredTargets/" + i0,schemaPath:"#/properties/coveredTargets/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid1 = _errs4 === errors;
if(!valid1){
break;
}
}
}
else {
validate268.errors = [{instancePath:instancePath+"/coveredTargets",schemaPath:"#/properties/coveredTargets/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.inputDigest !== undefined){
const _errs6 = errors;
if(typeof data.inputDigest !== "string"){
validate268.errors = [{instancePath:instancePath+"/inputDigest",schemaPath:"#/properties/inputDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs6 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.key !== undefined){
const _errs8 = errors;
if(!(validate257(data.key, {instancePath:instancePath+"/key",parentData:data,parentDataProperty:"key",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate257.errors : vErrors.concat(validate257.errors);
errors = vErrors.length;
}
var valid0 = _errs8 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.outcome !== undefined){
const _errs9 = errors;
if(!(validate270(data.outcome, {instancePath:instancePath+"/outcome",parentData:data,parentDataProperty:"outcome",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate270.errors : vErrors.concat(validate270.errors);
errors = vErrors.length;
}
var valid0 = _errs9 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.scopeDigest !== undefined){
const _errs10 = errors;
if(typeof data.scopeDigest !== "string"){
validate268.errors = [{instancePath:instancePath+"/scopeDigest",schemaPath:"#/properties/scopeDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs10 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
}
}
else {
validate268.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate268.errors = vErrors;
return errors === 0;
}
validate268.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate255(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate255.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.results === undefined) && (missing0 = "results")) || ((data.diagnostics === undefined) && (missing0 = "diagnostics"))){
validate255.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "diagnostics") || (key0 === "results"))){
validate255.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.diagnostics !== undefined){
let data0 = data.diagnostics;
const _errs2 = errors;
if(errors === _errs2){
if(Array.isArray(data0)){
var valid1 = true;
const len0 = data0.length;
for(let i0=0; i0<len0; i0++){
const _errs4 = errors;
if(!(validate256(data0[i0], {instancePath:instancePath+"/diagnostics/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate256.errors : vErrors.concat(validate256.errors);
errors = vErrors.length;
}
var valid1 = _errs4 === errors;
if(!valid1){
break;
}
}
}
else {
validate255.errors = [{instancePath:instancePath+"/diagnostics",schemaPath:"#/properties/diagnostics/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.results !== undefined){
let data2 = data.results;
const _errs5 = errors;
if(errors === _errs5){
if(Array.isArray(data2)){
var valid2 = true;
const len1 = data2.length;
for(let i1=0; i1<len1; i1++){
const _errs7 = errors;
if(!(validate268(data2[i1], {instancePath:instancePath+"/results/" + i1,parentData:data2,parentDataProperty:i1,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate268.errors : vErrors.concat(validate268.errors);
errors = vErrors.length;
}
var valid2 = _errs7 === errors;
if(!valid2){
break;
}
}
}
else {
validate255.errors = [{instancePath:instancePath+"/results",schemaPath:"#/properties/results/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
else {
validate255.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate255.errors = vErrors;
return errors === 0;
}
validate255.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
