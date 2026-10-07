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
export const validate = validate277;
export default validate277;
const schema298 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"GenerationServiceError","type":"object","properties":{"code":{"$ref":"#/$defs/GenerationServiceErrorCode"}},"additionalProperties":false,"required":["code"],"$defs":{"GenerationServiceErrorCode":{"type":"string","enum":["invalid-input","unavailable","permission-denied","cancelled","limit-exceeded","conflict","busy","storage-failed","outcome-unknown"]}}};
const schema299 = {"type":"string","enum":["invalid-input","unavailable","permission-denied","cancelled","limit-exceeded","conflict","busy","storage-failed","outcome-unknown"]};

function validate277(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate277.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((data.code === undefined) && (missing0 = "code")){
validate277.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(key0 === "code")){
validate277.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.code !== undefined){
let data0 = data.code;
if(typeof data0 !== "string"){
validate277.errors = [{instancePath:instancePath+"/code",schemaPath:"#/$defs/GenerationServiceErrorCode/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(((((((((data0 === "invalid-input") || (data0 === "unavailable")) || (data0 === "permission-denied")) || (data0 === "cancelled")) || (data0 === "limit-exceeded")) || (data0 === "conflict")) || (data0 === "busy")) || (data0 === "storage-failed")) || (data0 === "outcome-unknown"))){
validate277.errors = [{instancePath:instancePath+"/code",schemaPath:"#/$defs/GenerationServiceErrorCode/enum",keyword:"enum",params:{allowedValues: schema299.enum},message:"must be equal to one of the allowed values"}];
return false;
}
}
}
}
}
else {
validate277.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate277.errors = vErrors;
return errors === 0;
}
validate277.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
